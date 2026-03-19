import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { join } from 'node:path';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AppConfigService } from './app.config';
import { GoogleDriveService } from './google-drive.service';
import { AiService } from './ai.service';
import { TelegramBotService } from './telegram.service';
import { UploadService } from './upload.service';
import { PrismaService } from './prisma.service';
import { MediaProcessingService } from './media-processing.service';
import { ArticlePipelineService } from './article-pipeline.service';
import { SocialPublisherService } from './social-publisher.service';
import { NotionStatusSyncService } from './notion-status-sync.service';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: join(process.cwd(), '.env'),
    }),
  ],
  controllers: [AppController],
  providers: [
    AppConfigService,
    PrismaService,
    AppService,
    GoogleDriveService,
    AiService,
    MediaProcessingService,
    TelegramBotService,
    UploadService,
    ArticlePipelineService,
    SocialPublisherService,
    NotionStatusSyncService,
  ],
})
export class AppModule {}
