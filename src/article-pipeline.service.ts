import { Injectable, Logger } from '@nestjs/common';
import * as cheerio from 'cheerio';
import Parser from 'rss-parser';
import { ArticleSourceConfig } from './domain/interfaces';
import { sha256, truncate } from './utils/text';

const HTML_LINK_LIMIT = 50;
const EXCERPT_LIMIT = 1_200;

export interface FetchedArticle {
  sourceName: string;
  sourceUrl: string;
  title: string;
  url: string;
  canonicalUrl: string;
  publishedAt?: Date;
  excerpt?: string;
  bodyText?: string;
  contentHash: string;
  dedupeKey: string;
}

@Injectable()
export class ArticlePipelineService {
  private readonly logger = new Logger(ArticlePipelineService.name);
  private readonly parser = new Parser();

  async fetchArticles(sources: ArticleSourceConfig[]): Promise<FetchedArticle[]> {
    const results: FetchedArticle[] = [];
    for (const source of sources) {
      try {
        const batch = await this.fetchSource(source);
        results.push(...batch);
      } catch (error) {
        this.logger.warn(`Article source failed for ${source.name}: ${error}`);
      }
    }
    return results;
  }

  private async fetchSource(source: ArticleSourceConfig): Promise<FetchedArticle[]> {
    switch (source.type) {
      case 'rss':
        return this.fetchRssSource(source);
      case 'telegram':
        return this.fetchTelegramSource(source);
      case 'x':
        return this.fetchXSource(source);
      case 'html':
      default:
        return this.fetchHtmlSource(source);
    }
  }

  private async fetchRssSource(source: ArticleSourceConfig): Promise<FetchedArticle[]> {
    const feed = await this.parser.parseURL(source.url);
    const results: FetchedArticle[] = [];
    for (const item of feed.items ?? []) {
      const url = item.link?.trim();
      if (!url) {
        continue;
      }
      const title = (item.title ?? 'Untitled article').trim();
      const excerpt = truncate((item.contentSnippet ?? item.content ?? '').trim(), EXCERPT_LIMIT);
      const canonicalUrl = this.normalizeUrl(url);
      const publishedAt = item.isoDate ? new Date(item.isoDate) : item.pubDate ? new Date(item.pubDate) : undefined;
      results.push(this.makeFetchedArticle(source, title, url, canonicalUrl, excerpt, excerpt, publishedAt));
    }
    return results;
  }

  private async fetchHtmlSource(source: ArticleSourceConfig): Promise<FetchedArticle[]> {
    const { html } = await this.fetchPage(source.url);
    const $ = cheerio.load(html);
    const foundLinks = new Map<string, { title: string; excerpt: string }>();

    $('article a[href], main a[href], a[href]')
      .slice(0, HTML_LINK_LIMIT)
      .each((_, element) => {
        const href = $(element).attr('href');
        const text = $(element).text().trim();
        if (!href || !text || text.length < 20) {
          return;
        }
        const absolute = this.normalizeUrl(new URL(href, source.url).toString());
        if (!absolute.startsWith('http')) {
          return;
        }
        const excerpt = truncate($(element).closest('article').text().trim(), 600);
        foundLinks.set(absolute, {
          title: truncate(text, 200),
          excerpt,
        });
      });

    return Array.from(foundLinks.entries()).map(([url, meta]) =>
      this.makeFetchedArticle(source, meta.title, url, url, meta.excerpt, meta.excerpt),
    );
  }

  private async fetchTelegramSource(source: ArticleSourceConfig): Promise<FetchedArticle[]> {
    const { html } = await this.fetchPage(source.url);
    const $ = cheerio.load(html);
    const results: FetchedArticle[] = [];

    $('.tgme_widget_message_wrap')
      .slice(-HTML_LINK_LIMIT)
      .each((_, element) => {
        const link = $(element).find('.tgme_widget_message_date').attr('href')?.trim();
        const textRoot = $(element).find('.tgme_widget_message_text');
        const bodyText = truncate(textRoot.text().trim(), EXCERPT_LIMIT);
        const title = truncate(bodyText.split('\n')[0]?.trim() || 'Telegram post', 200);
        if (!link || !bodyText) {
          return;
        }

        const datetime = $(element).find('time').attr('datetime');
        const publishedAt = datetime ? new Date(datetime) : undefined;
        const canonicalUrl = this.normalizeUrl(new URL(link, source.url).toString());
        results.push(
          this.makeFetchedArticle(
            source,
            title,
            canonicalUrl,
            canonicalUrl,
            truncate(bodyText, 600),
            bodyText,
            publishedAt,
          ),
        );
      });

    return results;
  }

  private async fetchXSource(source: ArticleSourceConfig): Promise<FetchedArticle[]> {
    const { html, contentType } = await this.fetchPage(source.url);
    if (contentType.includes('xml') || contentType.includes('rss') || html.trim().startsWith('<?xml')) {
      return this.fetchRssFromString(source, html);
    }

    const $ = cheerio.load(html);
    const results: FetchedArticle[] = [];
    const seen = new Set<string>();

    $('[data-testid="tweet"], article, div[data-testid="cellInnerDiv"]')
      .slice(0, HTML_LINK_LIMIT)
      .each((_, element) => {
        const statusLink =
          $(element).find('a[href*="/status/"]').attr('href') ??
          $(element).find('time').parent('a').attr('href');
        if (!statusLink) {
          return;
        }

        const absolute = this.normalizeUrl(new URL(statusLink, source.url).toString());
        if (seen.has(absolute)) {
          return;
        }
        seen.add(absolute);

        const text = truncate(
          $(element)
            .find('[lang], div[dir="auto"]')
            .map((__, node) => $(node).text().trim())
            .get()
            .filter(Boolean)
            .join('\n')
            .trim(),
          EXCERPT_LIMIT,
        );
        const title = truncate(text.split('\n')[0]?.trim() || 'X post', 200);
        const datetime = $(element).find('time').attr('datetime');
        const publishedAt = datetime ? new Date(datetime) : undefined;

        if (!text) {
          return;
        }

        results.push(
          this.makeFetchedArticle(source, title, absolute, absolute, truncate(text, 600), text, publishedAt),
        );
      });

    return results;
  }

  private async fetchRssFromString(source: ArticleSourceConfig, raw: string): Promise<FetchedArticle[]> {
    const feed = await this.parser.parseString(raw);
    return (feed.items ?? [])
      .map((item) => {
        const url = item.link?.trim();
        if (!url) {
          return null;
        }
        const title = (item.title ?? 'Untitled article').trim();
        const excerpt = truncate((item.contentSnippet ?? item.content ?? '').trim(), EXCERPT_LIMIT);
        const publishedAt = item.isoDate ? new Date(item.isoDate) : item.pubDate ? new Date(item.pubDate) : undefined;
        const canonicalUrl = this.normalizeUrl(url);
        return this.makeFetchedArticle(source, title, url, canonicalUrl, excerpt, excerpt, publishedAt);
      })
      .filter((item): item is FetchedArticle => Boolean(item));
  }

  private async fetchPage(url: string): Promise<{ html: string; contentType: string }> {
    const response = await fetch(url, {
      headers: {
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0 Safari/537.36',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    if (!response.ok) {
      throw new Error(`Source returned ${response.status}`);
    }

    return {
      html: await response.text(),
      contentType: response.headers.get('content-type')?.toLowerCase() ?? '',
    };
  }

  private makeFetchedArticle(
    source: ArticleSourceConfig,
    title: string,
    url: string,
    canonicalUrl: string,
    excerpt?: string,
    bodyText?: string,
    publishedAt?: Date,
  ): FetchedArticle {
    const contentHash = sha256(`${title}\n${excerpt ?? ''}\n${bodyText ?? ''}`);
    return {
      sourceName: source.name,
      sourceUrl: source.url,
      title,
      url,
      canonicalUrl,
      publishedAt,
      excerpt,
      bodyText,
      contentHash,
      dedupeKey: sha256(`${canonicalUrl}|${publishedAt?.toISOString() ?? ''}|${contentHash}`),
    };
  }

  private normalizeUrl(value: string): string {
    const url = new URL(value);
    url.hash = '';
    const blocked = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_id', 'utm_term', 'utm_content', 'fbclid'];
    for (const key of blocked) {
      url.searchParams.delete(key);
    }
    return url.toString();
  }
}
