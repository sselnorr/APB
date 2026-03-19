import { Injectable } from '@nestjs/common';
import { PublisherAdapter } from './domain/interfaces';

export interface SocialPublishPayload {
  title: string;
  body: string;
  imageFileId?: string | null;
  textFileId?: string | null;
}

@Injectable()
export class SocialPublisherService implements PublisherAdapter<SocialPublishPayload, { status: string }> {
  isConfigured(): boolean {
    return false;
  }

  async publish(_payload: SocialPublishPayload): Promise<{ status: string }> {
    return { status: 'awaiting_external_api_config' };
  }
}
