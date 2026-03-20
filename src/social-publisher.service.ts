import { Injectable, Logger } from '@nestjs/common';
import { basename } from 'node:path';
import { readFile, unlink } from 'node:fs/promises';
import { AppConfigService } from './app.config';
import { PublisherAdapter } from './domain/interfaces';
import { GoogleDriveService } from './google-drive.service';
import { truncate } from './utils/text';

export interface SocialPublishPayload {
  title: string;
  body: string;
  imageFileId?: string | null;
  imageMimeType?: string | null;
  textFileId?: string | null;
}

export interface SocialPublishResult {
  requestId?: string;
  status: 'completed' | 'partial' | 'failed';
  results: Array<{ platform: string; success: boolean; message?: string }>;
  raw: string;
}

@Injectable()
export class SocialPublisherService
  implements PublisherAdapter<SocialPublishPayload, SocialPublishResult>
{
  private readonly logger = new Logger(SocialPublisherService.name);

  constructor(
    private readonly appConfig: AppConfigService,
    private readonly drive: GoogleDriveService,
  ) {}

  isConfigured(): boolean {
    return Boolean(this.appConfig.uploadPostApiKey && this.appConfig.uploadSocialProfile);
  }

  async publish(payload: SocialPublishPayload): Promise<SocialPublishResult> {
    if (!this.isConfigured()) {
      throw new Error('Upload-Post social publisher is not configured');
    }
    if (!payload.imageFileId) {
      throw new Error('imageFileId is required for social publication');
    }

    const imagePath = await this.drive.downloadFile(
      payload.imageFileId,
      `${this.safeFileStem(payload.title)}${this.extensionByMime(payload.imageMimeType)}`,
    );

    try {
      const buffer = await readFile(imagePath);
      const form = new FormData();
      form.append(
        'photos[]',
        new Blob([buffer], { type: payload.imageMimeType ?? 'image/png' }),
        basename(imagePath),
      );

      form.append('user', this.appConfig.uploadSocialProfile);
      form.append('title', payload.body);
      form.append('description', payload.body);
      form.append('facebook_title', payload.body);
      form.append('x_title', payload.body);
      form.append('threads_title', payload.body);
      form.append('facebook_media_type', 'POSTS');
      form.append('async_upload', 'true');

      for (const platform of this.appConfig.uploadSocialPlatforms) {
        form.append('platform[]', platform);
      }

      const response = await fetch('https://api.upload-post.com/api/upload_photos', {
        method: 'POST',
        headers: {
          Authorization: `Apikey ${this.appConfig.uploadPostApiKey}`,
        },
        body: form,
      });

      const raw = await response.text();
      this.logger.log(`Upload-Post social init response: status=${response.status} body=${truncate(raw, 800)}`);
      if (!response.ok) {
        throw new Error(`Upload-Post social upload failed ${response.status}: ${raw}`);
      }

      const parsed = this.tryParseJson(raw);
      const requestId = typeof parsed?.request_id === 'string' ? parsed.request_id : undefined;
      if (!requestId) {
        return this.buildResult(parsed, raw);
      }

      return this.pollAsyncStatus(requestId);
    } finally {
      await unlink(imagePath).catch(() => undefined);
    }
  }

  private async pollAsyncStatus(requestId: string): Promise<SocialPublishResult> {
    for (let attempt = 1; attempt <= 120; attempt += 1) {
      const url = `https://api.upload-post.com/api/uploadposts/status?request_id=${encodeURIComponent(requestId)}`;
      const response = await fetch(url, {
        headers: {
          Authorization: `Apikey ${this.appConfig.uploadPostApiKey}`,
        },
      });
      const raw = await response.text();
      if (!response.ok) {
        throw new Error(`Upload-Post social status failed ${response.status}: ${raw}`);
      }

      const parsed = this.tryParseJson(raw);
      const status = typeof parsed?.status === 'string' ? parsed.status : 'unknown';
      if (status === 'completed') {
        return this.buildResult(parsed, raw, requestId);
      }
      if (status === 'failed' || status === 'error') {
        return this.buildResult(parsed, raw, requestId);
      }

      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    throw new Error(`Upload-Post social status timeout for request ${requestId}`);
  }

  private buildResult(obj: any, raw: string, requestId?: string): SocialPublishResult {
    const results = this.collectPlatformResults(obj);
    const successCount = results.filter((item) => item.success).length;
    const status: SocialPublishResult['status'] =
      successCount === results.length ? 'completed' : successCount > 0 ? 'partial' : 'failed';

    return {
      requestId,
      status,
      results,
      raw,
    };
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
      return this.appConfig.uploadSocialPlatforms.map((platform) => ({
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

  private extensionByMime(mimeType?: string | null): string {
    if (mimeType === 'image/jpeg') return '.jpg';
    if (mimeType === 'image/webp') return '.webp';
    return '.png';
  }

  private safeFileStem(title: string): string {
    const compact = title.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60);
    return compact || 'social-post';
  }
}
