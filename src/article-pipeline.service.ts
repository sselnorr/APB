import { Injectable, Logger } from '@nestjs/common';
import * as cheerio from 'cheerio';
import Parser from 'rss-parser';
import { ArticleSourceConfig } from './domain/interfaces';
import { sha256, truncate } from './utils/text';

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
        const batch = source.type === 'rss' ? await this.fetchRssSource(source) : await this.fetchHtmlSource(source);
        results.push(...batch);
      } catch (error) {
        this.logger.warn(`Article source failed for ${source.name}: ${error}`);
      }
    }
    return results;
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
      const excerpt = (item.contentSnippet ?? item.content ?? '').trim();
      const canonicalUrl = this.normalizeUrl(url);
      const publishedAt = item.isoDate ? new Date(item.isoDate) : item.pubDate ? new Date(item.pubDate) : undefined;
      const contentHash = sha256(`${title}\n${excerpt}`);
      results.push({
        sourceName: source.name,
        sourceUrl: source.url,
        title,
        url,
        canonicalUrl,
        publishedAt,
        excerpt,
        bodyText: excerpt,
        contentHash,
        dedupeKey: sha256(`${canonicalUrl}|${publishedAt?.toISOString() ?? ''}|${contentHash}`),
      });
    }
    return results;
  }

  private async fetchHtmlSource(source: ArticleSourceConfig): Promise<FetchedArticle[]> {
    const response = await fetch(source.url);
    if (!response.ok) {
      throw new Error(`HTML source returned ${response.status}`);
    }

    const html = await response.text();
    const $ = cheerio.load(html);
    const foundLinks = new Map<string, { title: string; excerpt: string }>();

    $('article a[href], main a[href], a[href]')
      .slice(0, 50)
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

    return Array.from(foundLinks.entries()).map(([url, meta]) => {
      const contentHash = sha256(`${meta.title}\n${meta.excerpt}`);
      return {
        sourceName: source.name,
        sourceUrl: source.url,
        title: meta.title,
        url,
        canonicalUrl: url,
        excerpt: meta.excerpt,
        bodyText: meta.excerpt,
        contentHash,
        dedupeKey: sha256(`${url}|${contentHash}`),
      };
    });
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
