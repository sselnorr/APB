import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { basename } from 'node:path';
import { readFile, stat } from 'node:fs/promises';

type UploadSource =
  | { type: 'url'; value: string }
  | { type: 'file'; value: string };

@Injectable()
export class UploadService {
  private readonly logger = new Logger(UploadService.name);
  private readonly apiKey?: string;
  private readonly primaryUser: string;
  private readonly fallbackUser?: string;
  private readonly enabledPlatforms: string[];
  private readonly statusPollMaxAttempts: number;
  private readonly statusPollDelayMs: number;

  constructor(config: ConfigService) {
    this.apiKey = config.get<string>('UPLOAD_POST_API_KEY')?.trim();
    this.primaryUser =
      config.get<string>('UPLOAD_POST_USERNAME')?.trim() ||
      config.get<string>('UPLOAD_POST_PROFILE_USERNAME')?.trim() ||
      'crypto_kettle_btc';
    this.fallbackUser = config.get<string>('UPLOAD_POST_FALLBACK_USERNAME')?.trim() || 'APB-3';
    this.enabledPlatforms = this.resolvePlatforms(config);
    this.statusPollMaxAttempts = this.parseNumber(config.get<string>('UPLOAD_POST_STATUS_MAX_ATTEMPTS')) ?? 120;
    this.statusPollDelayMs = this.parseNumber(config.get<string>('UPLOAD_POST_STATUS_DELAY_MS')) ?? 8000;
  }

  async publishFromUrl(videoUrl: string, title: string, caption: string): Promise<void> {
    await this.publishWithFallbackUsers({ type: 'url', value: videoUrl }, title, caption);
  }

  async publishFromFile(videoPath: string, title: string, caption: string): Promise<void> {
    await this.publishWithFallbackUsers({ type: 'file', value: videoPath }, title, caption);
  }

  private async publishWithFallbackUsers(source: UploadSource, title: string, caption: string): Promise<void> {
    if (!this.apiKey) {
      throw new Error('UPLOAD_POST_API_KEY is missing');
    }

    const usersToTry = [this.primaryUser, this.fallbackUser].filter(
      (value, index, arr): value is string => Boolean(value) && arr.indexOf(value) === index,
    );

    let lastError = 'Unknown Upload Post error';

    for (const user of usersToTry) {
      this.logger.log(
        `Upload init: source=${source.type}, user=${user}, platforms=${this.enabledPlatforms.join(',')}`,
      );

      const result = await this.submitUpload(source, title, caption, user);
      if (result.ok) {
        this.logger.log(`Upload accepted for user=${user}`);
        return;
      }

      lastError = result.error;
      const lower = result.error.toLowerCase();
      const canRetryWithAnotherUser =
        lower.includes('user not found') || lower.includes('username not found') || lower.includes('profile not found');

      if (!canRetryWithAnotherUser) {
        break;
      }
    }

    throw new Error(lastError);
  }

  private async submitUpload(
    source: UploadSource,
    title: string,
    caption: string,
    user: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const form = new FormData();

    if (source.type === 'url') {
      form.append('video', source.value);
      this.logger.log(`Upload source URL: ${source.value}`);
    } else {
      const fileStats = await stat(source.value);
      this.logger.log(
        `Upload source FILE: ${basename(source.value)} ${(fileStats.size / 1024 / 1024).toFixed(2)}MB`,
      );
      const buffer = await readFile(source.value);
      const blob = new Blob([buffer], { type: this.videoMimeByName(source.value) });
      form.append('video', blob, basename(source.value));
    }

    form.append('title', title);
    form.append('description', caption);
    form.append('youtube_title', title);
    form.append('youtube_description', caption);
    form.append('instagram_title', title);
    form.append('media_type', 'REELS');
    form.append('user', user);
    form.append('username', user);
    form.append('async_upload', 'true');

    for (const platform of this.enabledPlatforms) {
      form.append('platform[]', platform);
    }

    const startedAt = Date.now();
    const response = await fetch('https://api.upload-post.com/api/upload', {
      method: 'POST',
      headers: {
        Authorization: `Apikey ${this.apiKey}`,
      },
      body: form,
    });
    const body = await response.text();
    const durationMs = Date.now() - startedAt;

    this.logger.log(
      `Upload response: status=${response.status}, durationMs=${durationMs}, body=${this.truncate(body, 700)}`,
    );

    if (!response.ok) {
      if (response.status === 504 && source.type === 'file') {
        return {
          ok: false,
          error:
            'Upload failed 504: Gateway Timeout. Most likely file upload timeout for large video. Retry via URL source is required.',
        };
      }
      return {
        ok: false,
        error: `Upload failed ${response.status}: ${body}`,
      };
    }

    const parsed = this.tryParseJson(body);
    const requestId = this.readStringField(parsed, 'request_id');
    if (!requestId) {
      const failures = this.collectPlatformFailures(parsed);
      if (failures.length) {
        return {
          ok: false,
          error: `Upload API returned platform errors: ${failures.join('; ')}`,
        };
      }
      return { ok: true };
    }

    return this.waitForAsyncCompletion(requestId);
  }

  private async waitForAsyncCompletion(
    requestId: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const maxAttempts = this.statusPollMaxAttempts;
    const delayMs = this.statusPollDelayMs;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const url = `https://api.upload-post.com/api/uploadposts/status?request_id=${encodeURIComponent(requestId)}`;
      const response = await fetch(url, {
        headers: { Authorization: `Apikey ${this.apiKey}` },
      });
      const body = await response.text();

      if (!response.ok) {
        return {
          ok: false,
          error: `Upload status failed ${response.status}: ${body}`,
        };
      }

      const parsed = this.tryParseJson(body);
      const status = this.readStringField(parsed, 'status') ?? 'unknown';
      const completed = this.readNumberField(parsed, 'completed');
      const total = this.readNumberField(parsed, 'total');

      this.logger.log(
        `Upload status poll ${attempt}/${maxAttempts}: request_id=${requestId}, status=${status}, completed=${completed ?? 'n/a'}, total=${total ?? 'n/a'}`,
      );

      if (status === 'completed') {
        const failures = this.collectPlatformFailures(parsed);
        if (failures.length) {
          return {
            ok: false,
            error: `Upload completed with platform errors: ${failures.join('; ')}`,
          };
        }
        return { ok: true };
      }

      if (status === 'failed' || status === 'error') {
        return {
          ok: false,
          error: `Upload async failed: ${body}`,
        };
      }

      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    return {
      ok: false,
      error: `Upload status timeout: request_id=${requestId} did not complete in allotted time`,
    };
  }

  private resolvePlatforms(config: ConfigService): string[] {
    const fromEnv = config.get<string>('UPLOAD_POST_PLATFORMS')?.trim();
    if (fromEnv) {
      const parsed = fromEnv
        .split(',')
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean);
      if (parsed.length) {
        return parsed;
      }
    }

    const includeTiktok = (config.get<string>('UPLOAD_POST_INCLUDE_TIKTOK') ?? '')
      .trim()
      .toLowerCase();

    return includeTiktok === '1' || includeTiktok === 'true'
      ? ['youtube', 'instagram', 'tiktok']
      : ['youtube', 'instagram'];
  }

  private videoMimeByName(path: string): string {
    const lower = path.toLowerCase();
    if (lower.endsWith('.mov')) return 'video/quicktime';
    if (lower.endsWith('.webm')) return 'video/webm';
    if (lower.endsWith('.mkv')) return 'video/x-matroska';
    if (lower.endsWith('.avi')) return 'video/x-msvideo';
    if (lower.endsWith('.m4v')) return 'video/x-m4v';
    return 'video/mp4';
  }

  private tryParseJson(raw: string): any {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  private readStringField(obj: any, field: string): string | undefined {
    const value = obj?.[field];
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  }

  private readNumberField(obj: any, field: string): number | undefined {
    const value = obj?.[field];
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  }

  private collectPlatformFailures(obj: any): string[] {
    const rows = Array.isArray(obj?.results)
      ? obj.results
      : obj?.results && typeof obj.results === 'object'
        ? Object.entries(obj.results).map(([platform, row]) => ({ platform, ...(row as object) }))
        : [];

    const failures: string[] = [];

    for (const row of rows) {
      const platform = typeof row?.platform === 'string' ? row.platform : 'unknown';
      const success = Boolean(row?.success);
      if (success) {
        continue;
      }
      const message =
        (typeof row?.message === 'string' && row.message) ||
        (typeof row?.error === 'string' && row.error) ||
        'unknown platform error';
      failures.push(`${platform}: ${message}`);
    }

    return failures;
  }

  private truncate(value: string, max: number): string {
    if (value.length <= max) {
      return value;
    }
    return `${value.slice(0, max)}...`;
  }

  private parseNumber(value: string | undefined): number | undefined {
    if (!value) {
      return undefined;
    }
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  }
}
