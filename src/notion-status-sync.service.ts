import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class NotionStatusSyncService {
  private readonly logger = new Logger(NotionStatusSyncService.name);

  isConfigured(): boolean {
    return false;
  }

  async handleVideoPublished(videoTitle: string): Promise<void> {
    this.logger.debug(`Notion sync skipped for ${videoTitle}: adapter placeholder is not configured`);
  }
}
