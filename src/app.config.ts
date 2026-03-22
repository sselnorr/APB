import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ArticleSourceConfig } from './domain/interfaces';
import { PublishWindowConfig, parsePublishWindows } from './utils/time';
import { normalizePrompt } from './utils/text';

const DEFAULT_VIDEO_PROMPT = [
  'Ты создаешь описание к короткому вертикальному видео на русском языке.',
  'Сформируй чистое описание для публикации без упоминаний ИИ.',
  'Отдельной строкой добавь релевантные хэштеги.',
].join('\n');

const DEFAULT_CLUSTER_PROMPT = [
  'Ты анализируешь новые статьи по финансам и крипте.',
  'Найди общую тему, главные выводы и отличия между источниками.',
  'Ответ должен быть кратким и пригодным для дальнейшего переписывания в посты.',
].join('\n');

const DEFAULT_TELEGRAM_DRAFT_PROMPT = [
  'Напиши пост для личного Telegram-канала на русском языке.',
  'Стиль: уверенный, информативный, без воды.',
  'Упоминай только факты из summary и источников.',
].join('\n');

const DEFAULT_SOCIAL_DRAFT_PROMPT = [
  'Напиши отдельную публикацию для общих социальных платформ на русском языке.',
  'Сделай текст самодостаточным, читаемым и пригодным для X, Threads и Facebook.',
  'Не добавляй непроверенные факты.',
].join('\n');

const DEFAULT_IMAGE_PROMPT = [
  'Сформируй prompt для генерации иллюстрации к финансовой/крипто публикации.',
  'Опиши композицию, стиль и ключевой визуальный акцент.',
].join('\n');

const DEFAULT_UPLOAD_VIDEO_FIRST_COMMENT =
  'Друзья, спасибо что смотрите мой контент! Проявите активность на моих видео, тем самым вы поддержите мои старания 🤗 ';

@Injectable()
export class AppConfigService {
  constructor(private readonly config: ConfigService) {}

  get port(): number {
    return this.number('PORT') ?? 4200;
  }

  get databaseUrl(): string | undefined {
    return this.clean('DATABASE_URL');
  }

  get timezone(): string {
    return this.clean('APP_TIMEZONE') ?? 'Europe/Berlin';
  }

  get publishWindows(): PublishWindowConfig {
    return {
      timezone: this.timezone,
      windows: parsePublishWindows(this.clean('PUBLISH_WINDOWS')),
    };
  }

  get ingestFolderId(): string {
    return this.required('GOOGLE_DRIVE_INGEST_FOLDER_ID');
  }

  get sentFolderId(): string {
    return this.required('GOOGLE_DRIVE_SENT_FOLDER_ID');
  }

  get writtenFolderId(): string {
    return this.required('GOOGLE_DRIVE_WRITTEN_FOLDER_ID');
  }

  get publishedFolderId(): string {
    return this.required('GOOGLE_DRIVE_PUBLISHED_FOLDER_ID');
  }

  get tgDraftsFolderId(): string {
    return this.required('GOOGLE_DRIVE_TG_DRAFTS_FOLDER_ID');
  }

  get downloadDir(): string {
    return this.clean('GOOGLE_DRIVE_DOWNLOAD_DIR') ?? 'downloads/assets';
  }

  get telegramBotToken(): string | undefined {
    return this.clean('TELEGRAM_BOT_TOKEN');
  }

  get telegramOwnerChatId(): number | undefined {
    return this.number('TELEGRAM_OWNER_CHAT_ID');
  }

  get telegramChannelId(): string | undefined {
    return this.clean('TELEGRAM_CHANNEL_ID');
  }

  get ffmpegPath(): string {
    return this.clean('FFMPEG_PATH') ?? 'ffmpeg';
  }

  get openAiApiKey(): string | undefined {
    return this.clean('OPENAI_API_KEY');
  }

  get openAiTextModel(): string {
    return this.clean('OPENAI_TEXT_MODEL') ?? 'gpt-4.1';
  }

  get openAiTranscribeModel(): string {
    return this.clean('OPENAI_TRANSCRIBE_MODEL') ?? 'whisper-1';
  }

  get openAiImageModel(): string {
    return this.clean('OPENAI_IMAGE_MODEL') ?? 'gpt-image-1';
  }

  get uploadPostApiKey(): string | undefined {
    return this.clean('UPLOAD_POST_API_KEY');
  }

  get uploadPostUsername(): string | undefined {
    return this.clean('UPLOAD_POST_USERNAME');
  }

  get uploadPlatforms(): string[] {
    const raw = (this.clean('UPLOAD_POST_PLATFORMS') ?? 'youtube,instagram,tiktok')
      .split(',')
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean);

    return raw.filter((platform) => {
      if (platform === 'youtube') {
        return this.youtubeEnabled;
      }
      if (platform === 'instagram') {
        return this.reelsEnabled;
      }
      if (platform === 'tiktok') {
        return this.tiktokEnabled;
      }
      return true;
    });
  }

  get uploadVideoFirstComment(): string {
    return this.clean('UPLOAD_POST_VIDEO_FIRST_COMMENT') ?? DEFAULT_UPLOAD_VIDEO_FIRST_COMMENT;
  }

  get uploadSocialProfile(): string {
    return this.clean('UPLOAD_POST_SOCIAL_PROFILE') ?? 'crypto_text';
  }

  get uploadSocialPlatforms(): string[] {
    const raw = (this.clean('UPLOAD_POST_SOCIAL_PLATFORMS') ?? 'x,threads,facebook')
      .split(',')
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean);

    return raw.filter((platform) => {
      if (platform === 'x') {
        return this.xEnabled;
      }
      if (platform === 'threads') {
        return this.threadsEnabled;
      }
      if (platform === 'facebook') {
        return this.facebookEnabled;
      }
      return true;
    });
  }

  get youtubeEnabled(): boolean {
    return this.flag('YOUTUBE');
  }

  get reelsEnabled(): boolean {
    return this.flag('REELS');
  }

  get tiktokEnabled(): boolean {
    return this.flag('TIKTOK');
  }

  get xEnabled(): boolean {
    return this.flag('X');
  }

  get threadsEnabled(): boolean {
    return this.flag('THREADS');
  }

  get facebookEnabled(): boolean {
    return this.flag('FACEBOOK');
  }

  get videoDescriptionEnabled(): boolean {
    return this.flag('VIDEO_DESCRIPTION');
  }

  get telegramDraftEnabled(): boolean {
    return this.flag('TELEGRAM_DRAFT');
  }

  get socialDraftEnabled(): boolean {
    return this.flag('SOCIAL_DRAFT');
  }

  get postVideoFirstCommentEnabled(): boolean {
    return this.flag('POST_VIDEO_FIRST_COMMENT');
  }

  get generateSocialImageEnabled(): boolean {
    return this.flag('GENERATE_SOCIAL_IMAGE');
  }

  get videoPrompt(): string {
    return normalizePrompt(this.clean('PROMPT_VIDEO_DESCRIPTION'), DEFAULT_VIDEO_PROMPT);
  }

  get articleClusterPrompt(): string {
    return normalizePrompt(this.clean('PROMPT_ARTICLE_CLUSTER'), DEFAULT_CLUSTER_PROMPT);
  }

  get telegramDraftPrompt(): string {
    return normalizePrompt(this.clean('PROMPT_TELEGRAM_DRAFT'), DEFAULT_TELEGRAM_DRAFT_PROMPT);
  }

  get socialDraftPrompt(): string {
    return normalizePrompt(this.clean('PROMPT_SOCIAL_DRAFT'), DEFAULT_SOCIAL_DRAFT_PROMPT);
  }

  get imagePromptPrompt(): string {
    return normalizePrompt(this.clean('PROMPT_IMAGE_PROMPT'), DEFAULT_IMAGE_PROMPT);
  }

  get articleClusterEnabled(): boolean {
    return this.flag('ARTICLE_CLUSTER');
  }

  get articleSources(): ArticleSourceConfig[] {
    const raw = this.clean('ARTICLE_SOURCES_JSON');
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error('ARTICLE_SOURCES_JSON must be a JSON array');
    }

    return parsed.map((item, index) => {
      if (!item || typeof item !== 'object') {
        throw new Error(`ARTICLE_SOURCES_JSON[${index}] must be an object`);
      }
      const row = item as Record<string, unknown>;
      const name = typeof row.name === 'string' ? row.name.trim() : '';
      const url = typeof row.url === 'string' ? row.url.trim() : '';
      const type =
        row.type === 'html' || row.type === 'telegram' || row.type === 'x'
          ? row.type
          : 'rss';
      if (!name || !url) {
        throw new Error(`ARTICLE_SOURCES_JSON[${index}] must include name and url`);
      }
      return { name, url, type };
    });
  }

  get articleScanIntervalMs(): number {
    return 6 * 60 * 60 * 1000;
  }

  private clean(key: string): string | undefined {
    const value = this.config.get<string>(key);
    if (!value) {
      return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length ? trimmed : undefined;
  }

  private number(key: string): number | undefined {
    const value = this.clean(key);
    if (!value) {
      return undefined;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  private required(key: string): string {
    const value = this.clean(key);
    if (!value) {
      throw new Error(`${key} is required`);
    }
    return value;
  }

  private flag(key: string, fallback = true): boolean {
    const value = this.clean(key);
    if (!value) {
      return fallback;
    }
    const normalized = value.toLowerCase();
    if (['on', 'true', '1', 'yes'].includes(normalized)) {
      return true;
    }
    if (['off', 'false', '0', 'no'].includes(normalized)) {
      return false;
    }
    return fallback;
  }
}
