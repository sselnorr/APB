import { Injectable, Logger } from '@nestjs/common';
import { basename } from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { AppConfigService } from './app.config';
import { PublisherAdapter } from './domain/interfaces';
import { normalizeVideoDescription, truncate } from './utils/text';

export interface VideoPublishPayload {
  videoUrl: string;
  title: string;
  description: string;
}

export interface VideoPublishResult {
  requestId?: string;
  status: 'completed' | 'failed';
  results: Array<{ platform: string; success: boolean; message?: string }>;
  deferred: string[];
  raw: string;
}

@Injectable()
export class UploadService implements PublisherAdapter<VideoPublishPayload, VideoPublishResult> {
  private readonly logger = new Logger(UploadService.name);

  constructor(private readonly appConfig: AppConfigService) {}

  isConfigured(): boolean {
    return Boolean(
      this.appConfig.uploadPostApiKey &&
      this.appConfig.uploadPostUsername &&
      this.appConfig.uploadPlatforms.length,
    );
  }

  async publish(payload: VideoPublishPayload): Promise<VideoPublishResult> {
    if (!this.isConfigured()) {
      throw new Error('Upload-Post credentials are missing');
    }

    const description = normalizeVideoDescription(payload.description);
    const form = new FormData();
    form.append('video', payload.videoUrl);
    form.append('title', payload.title);
    form.append('description', description);
    form.append('tiktok_title', description);
    form.append('instagram_title', description);
    form.append('youtube_title', payload.title);
    form.append('youtube_description', description);
    if (this.appConfig.postVideoFirstCommentEnabled) {
      const firstComment = this.appConfig.uploadVideoFirstComment;
      form.append('instagram_first_comment', firstComment);
      form.append('youtube_first_comment', firstComment);
    }
    form.append('media_type', 'REELS');
    form.append('share_to_feed', 'true');
    form.append('privacy_level', 'PUBLIC_TO_EVERYONE');
    form.append('privacyStatus', 'public');
    form.append('post_mode', 'DIRECT_POST');
    form.append('selfDeclaredMadeForKids', 'false');
    form.append('containsSyntheticMedia', 'false');
    form.append('defaultLanguage', 'ru');
    form.append('defaultAudioLanguage', 'ru-RU');
    form.append('is_aigc', 'false');
    form.append('user', this.appConfig.uploadPostUsername as string);
    form.append('username', this.appConfig.uploadPostUsername as string);
    form.append('async_upload', 'true');

    for (const platform of this.appConfig.uploadPlatforms) {
      form.append('platform[]', platform);
    }

    const response = await fetch('https://api.upload-post.com/api/upload', {
      method: 'POST',
      headers: {
        Authorization: `Apikey ${this.appConfig.uploadPostApiKey}`,
      },
      body: form,
    });

    const raw = await response.text();
    this.logger.log(`Upload-Post init response: status=${response.status} body=${truncate(raw, 800)}`);

    if (!response.ok) {
      throw new Error(`Upload-Post upload failed ${response.status}: ${raw}`);
    }

    const parsed = this.tryParseJson(raw);
    const requestId = typeof parsed?.request_id === 'string' ? parsed.request_id : undefined;
    if (!requestId) {
      const results = this.collectPlatformResults(parsed);
      return {
        requestId,
        status: results.every((item) => item.success) ? 'completed' : 'failed',
        results,
        deferred: this.deferredNotes(),
        raw,
      };
    }

    return this.pollAsyncStatus(requestId);
  }

  async publishFromFile(videoPath: string, title: string, description: string): Promise<void> {
    const fileStats = await stat(videoPath);
    const buffer = await readFile(videoPath);
    const form = new FormData();
    form.append('video', new Blob([buffer], { type: this.videoMimeByName(videoPath) }), basename(videoPath));
    form.append('title', title);
    form.append('description', description);
    form.append('user', this.appConfig.uploadPostUsername as string);
    this.logger.warn(`Fallback file publish requested for ${title} (${(fileStats.size / 1024 / 1024).toFixed(2)}MB)`);
  }

  private async pollAsyncStatus(requestId: string): Promise<VideoPublishResult> {
    for (let attempt = 1; attempt <= 120; attempt += 1) {
      const url = `https://api.upload-post.com/api/uploadposts/status?request_id=${encodeURIComponent(requestId)}`;
      const response = await fetch(url, {
        headers: {
          Authorization: `Apikey ${this.appConfig.uploadPostApiKey}`,
        },
      });
      const raw = await response.text();
      if (!response.ok) {
        throw new Error(`Upload-Post status failed ${response.status}: ${raw}`);
      }

      const parsed = this.tryParseJson(raw);
      const status = typeof parsed?.status === 'string' ? parsed.status : 'unknown';
      if (status === 'completed') {
        const results = this.collectPlatformResults(parsed);
        return {
          requestId,
          status: results.every((item) => item.success) ? 'completed' : 'failed',
          results,
          deferred: this.deferredNotes(),
          raw,
        };
      }
      if (status === 'failed' || status === 'error') {
        return {
          requestId,
          status: 'failed',
          results: this.collectPlatformResults(parsed),
          deferred: this.deferredNotes(),
          raw,
        };
      }

      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    throw new Error(`Upload-Post status timeout for request ${requestId}`);
  }

  private tryParseJson(raw: string): any {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  private collectPlatformResults(obj: any): Array<{ platform: string; success: boolean; message?: string }> {
    const rows = Array.isArray(obj?.results)
      ? obj.results
      : obj?.results && typeof obj.results === 'object'
        ? Object.entries(obj.results).map(([platform, row]) => ({ platform, ...(row as object) }))
        : [];

    if (!rows.length) {
      return this.appConfig.uploadPlatforms.map((platform) => ({
        platform,
        success: true,
      }));
    }

    return rows.map((row: any) => ({
      platform: typeof row?.platform === 'string' ? row.platform : 'unknown',
      success: Boolean(row?.success),
      message:
        (typeof row?.message === 'string' && row.message) ||
        (typeof row?.error === 'string' && row.error) ||
        undefined,
    }));
  }

  private deferredNotes(): string[] {
    return [
      'Licensed library music selection remains deferred because Upload-Post public docs do not expose that capability.',
      'Undocumented editor-only switches are not auto-applied.',
      'Instagram library music cannot be selected via API; only the original embedded audio can be named.',
    ];
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
}
