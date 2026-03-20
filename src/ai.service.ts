import { Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';
import { createReadStream } from 'node:fs';
import { ArticleRecord } from '@prisma/client';
import { AppConfigService } from './app.config';
import { ContentClusterDto, DraftContent, ImageGeneratorAdapter } from './domain/interfaces';
import { normalizeVideoDescription, truncate } from './utils/text';

const ARTICLE_BATCH_LIMIT = 4;
const ARTICLE_CONTEXT_LIMIT = 900;
const INTERMEDIATE_SUMMARY_LIMIT = 1_200;

interface JsonDraftResponse {
  title?: string;
  body?: string;
  summary?: string;
  imagePrompt?: string;
}

@Injectable()
export class AiService implements ImageGeneratorAdapter {
  private readonly logger = new Logger(AiService.name);
  private readonly client?: OpenAI;

  constructor(private readonly appConfig: AppConfigService) {
    if (this.appConfig.openAiApiKey) {
      this.client = new OpenAI({ apiKey: this.appConfig.openAiApiKey });
    }
  }

  isConfigured(): boolean {
    return Boolean(this.client);
  }

  async transcribeAudio(audioPath: string): Promise<string> {
    if (!this.client) {
      throw new Error('OPENAI_API_KEY is missing');
    }

    const transcript = await this.client.audio.transcriptions.create({
      file: createReadStream(audioPath),
      model: this.appConfig.openAiTranscribeModel,
      response_format: 'text',
      language: 'ru',
    });

    return transcript.trim();
  }

  async generateVideoDescription(transcript: string, videoName: string): Promise<string> {
    const response = await this.chatJson([
      { role: 'system', content: this.appConfig.videoPrompt },
      {
        role: 'user',
        content: `Название видео: ${videoName}\n\nТранскрипт:\n${transcript}\n\nВерни JSON { "body": "..." }`,
      },
    ]);

    return normalizeVideoDescription(response.body?.trim() || response.summary?.trim() || transcript.slice(0, 500));
  }

  async buildCluster(articles: ArticleRecord[]): Promise<ContentClusterDto> {
    const batches = this.chunkArticles(articles);
    const partials: Array<{ title: string; summary: string }> = [];

    for (const batch of batches) {
      const sources = this.formatArticleBatch(batch);
      const response = await this.chatJson([
        { role: 'system', content: this.appConfig.articleClusterPrompt },
        {
          role: 'user',
          content: `Новые материалы:\n${sources}\n\nВерни JSON { "title": "...", "summary": "..." }`,
        },
      ]);

      partials.push({
        title: response.title?.trim() || batch[0]?.title || 'Новый дайджест',
        summary: response.summary?.trim() || response.body?.trim() || truncate(sources, INTERMEDIATE_SUMMARY_LIMIT),
      });
    }

    const finalResponse: JsonDraftResponse =
      partials.length === 1
        ? partials[0]
        : await this.chatJson([
            { role: 'system', content: this.appConfig.articleClusterPrompt },
            {
              role: 'user',
              content: `Сводки по батчам статей:\n${partials
                .map((item, index) => `${index + 1}. ${item.title}\n${truncate(item.summary, INTERMEDIATE_SUMMARY_LIMIT)}`)
                .join('\n\n')}\n\nВерни JSON { "title": "...", "summary": "..." }`,
            },
          ]);

    const title = finalResponse.title?.trim() || partials[0]?.title || articles[0]?.title || 'Новый дайджест';
    const summary =
      finalResponse.summary?.trim() ||
      finalResponse.body?.trim() ||
      partials.map((item) => item.summary).join('\n\n').slice(0, 2000);

    return {
      title,
      summary,
      sourceUrls: articles.map((article) => article.canonicalUrl),
      articleIds: articles.map((article) => article.id),
      fingerprint: articles.map((article) => article.dedupeKey).sort().join('|'),
    };
  }

  async generateTelegramDraft(summary: string, sourceUrls: string[]): Promise<DraftContent> {
    const response = await this.chatJson([
      { role: 'system', content: this.appConfig.telegramDraftPrompt },
      {
        role: 'user',
        content: `Summary:\n${summary}\n\nИсточники:\n${sourceUrls.join('\n')}\n\nВерни JSON { "title": "...", "body": "..." }`,
      },
    ]);

    return {
      title: response.title?.trim() || 'Telegram Draft',
      body: response.body?.trim() || summary,
    };
  }

  async rewriteTelegramDraft(currentBody: string, summary: string, sourceUrls: string[]): Promise<DraftContent> {
    const response = await this.chatJson([
      { role: 'system', content: this.appConfig.telegramDraftPrompt },
      {
        role: 'user',
        content: `Перепиши пост по той же теме иначе.\n\nТекущий текст:\n${currentBody}\n\nSummary:\n${summary}\n\nИсточники:\n${sourceUrls.join('\n')}\n\nВерни JSON { "title": "...", "body": "..." }`,
      },
    ]);

    return {
      title: response.title?.trim() || 'Telegram Draft',
      body: response.body?.trim() || currentBody,
    };
  }

  async generateSocialDraft(summary: string, sourceUrls: string[]): Promise<DraftContent> {
    const response = await this.chatJson([
      { role: 'system', content: this.appConfig.socialDraftPrompt },
      {
        role: 'user',
        content: `Summary:\n${summary}\n\nИсточники:\n${sourceUrls.join('\n')}\n\nВерни JSON { "title": "...", "body": "..." }`,
      },
    ]);

    return {
      title: response.title?.trim() || 'Social Draft',
      body: response.body?.trim() || summary,
    };
  }

  async generateImagePrompt(summary: string, socialBody: string): Promise<string> {
    const response = await this.chatJson([
      { role: 'system', content: this.appConfig.imagePromptPrompt },
      {
        role: 'user',
        content: `Summary:\n${summary}\n\nТекст публикации:\n${socialBody}\n\nВерни JSON { "imagePrompt": "..." }`,
      },
    ]);

    return response.imagePrompt?.trim() || `Create a clean editorial illustration for: ${socialBody}`;
  }

  async generate(prompt: string): Promise<{ mimeType: string; bytes: Buffer }> {
    if (!this.client) {
      throw new Error('OPENAI_API_KEY is missing');
    }

    const image = await this.client.images.generate({
      model: this.appConfig.openAiImageModel,
      prompt,
      size: '1536x1024',
    });

    const b64 = image.data?.[0]?.b64_json;
    if (!b64) {
      throw new Error('Image generation returned no image data');
    }

    return {
      mimeType: 'image/png',
      bytes: Buffer.from(b64, 'base64'),
    };
  }

  private async chatJson(
    messages: Array<{ role: 'system' | 'user'; content: string }>,
  ): Promise<JsonDraftResponse> {
    if (!this.client) {
      throw new Error('OPENAI_API_KEY is missing');
    }

    let response: OpenAI.Chat.Completions.ChatCompletion | undefined;
    let lastError: unknown;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        response = await this.client.chat.completions.create({
          model: this.appConfig.openAiTextModel,
          messages,
          temperature: 0.5,
          response_format: { type: 'json_object' },
        });
        break;
      } catch (error) {
        lastError = error;
        const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
        const retryable = message.includes('429') || message.includes('rate limit');
        if (!retryable || attempt === 2) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 12_000));
      }
    }

    if (!response) {
      throw lastError instanceof Error ? lastError : new Error(String(lastError ?? 'OpenAI request failed'));
    }

    const content = response.choices[0]?.message?.content;
    if (!content) {
      this.logger.warn('OpenAI returned empty content');
      return {};
    }

    try {
      return JSON.parse(content) as JsonDraftResponse;
    } catch {
      return { body: content, summary: content };
    }
  }

  private chunkArticles(articles: ArticleRecord[]): ArticleRecord[][] {
    const chunks: ArticleRecord[][] = [];
    let current: ArticleRecord[] = [];

    for (const article of articles) {
      current.push(article);
      if (current.length >= ARTICLE_BATCH_LIMIT) {
        chunks.push(current);
        current = [];
      }
    }

    if (current.length) {
      chunks.push(current);
    }

    return chunks;
  }

  private formatArticleBatch(articles: ArticleRecord[]): string {
    return articles
      .map((article) => {
        const excerpt = truncate((article.bodyText ?? article.excerpt ?? '').trim(), ARTICLE_CONTEXT_LIMIT);
        return `- ${article.title}\nURL: ${article.canonicalUrl}\n${excerpt}`;
      })
      .join('\n\n');
  }
}
