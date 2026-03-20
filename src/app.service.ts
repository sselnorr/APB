import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import {
  ArticleRecord,
  EditSessionStatus,
  SocialPublicationStatus,
  TelegramDraftStatus,
  VideoJobStatus,
} from '@prisma/client';
import { unlink } from 'node:fs/promises';
import { AppConfigService } from './app.config';
import { ArticlePipelineService } from './article-pipeline.service';
import { AiService } from './ai.service';
import { GoogleDriveService } from './google-drive.service';
import { MediaProcessingService } from './media-processing.service';
import { NotionStatusSyncService } from './notion-status-sync.service';
import { PrismaService } from './prisma.service';
import { SocialPublisherService } from './social-publisher.service';
import { TelegramBotService } from './telegram.service';
import { UploadService } from './upload.service';
import { nextPublishSlot, publishSlotKey } from './utils/time';
import { normalizeVideoDescription, sha256, slugify, stripExtension, truncate } from './utils/text';

@Injectable()
export class AppService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AppService.name);
  private readonly timers: NodeJS.Timeout[] = [];
  private dbReady = false;
  private processingVideo = false;
  private publishingVideo = false;
  private scanningArticles = false;
  private publishingSocial = false;

  constructor(
    private readonly appConfig: AppConfigService,
    private readonly prisma: PrismaService,
    private readonly drive: GoogleDriveService,
    private readonly ai: AiService,
    private readonly media: MediaProcessingService,
    private readonly telegram: TelegramBotService,
    private readonly uploader: UploadService,
    private readonly articlePipeline: ArticlePipelineService,
    private readonly socialPublisher: SocialPublisherService,
    private readonly notionSync: NotionStatusSyncService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.dbReady = await this.prisma.connectIfConfigured();

    this.telegram.setHandlers({
      onStart: (chatId) => this.handleStart(chatId),
      onDraftPublish: (draftId) => this.handleDraftPublish(draftId),
      onDraftEdit: (draftId) => this.handleDraftEdit(draftId),
      onDraftDelete: (draftId) => this.handleDraftDelete(draftId),
      onDraftDeleteConfirm: (draftId) => this.handleDraftDeleteConfirm(draftId),
      onDraftDeleteCancel: (draftId) => this.handleDraftDeleteCancel(draftId),
      onDraftRewrite: (draftId) => this.handleDraftRewrite(draftId),
      onEditClose: (draftId) => this.handleEditClose(draftId),
      onOwnerEditInput: (payload) => this.handleOwnerEditInput(payload),
    });

    await this.telegram.start();
    await this.verifyFfmpeg();

    if (!this.dbReady) {
      return;
    }

    await this.safeRun('startup', async () => {
      await this.discoverIngestVideos();
      await this.processNextVideo();
      await this.publishDueVideo();
      await this.scanArticlesIfDue();
    });

    this.timers.push(
      setInterval(() => void this.safeRun('video-discovery', async () => {
        await this.discoverIngestVideos();
        await this.processNextVideo();
      }), 15_000),
    );

    this.timers.push(
      setInterval(() => void this.safeRun('video-publish', async () => {
        await this.publishDueVideo();
        await this.publishDueSocial();
      }), 30_000),
    );

    this.timers.push(
      setInterval(() => void this.safeRun('article-scan', () => this.scanArticlesIfDue()), 60_000),
    );

    await this.notifyOwner('Сервис контент-машины запущен.');
  }

  onModuleDestroy(): void {
    for (const timer of this.timers) {
      clearInterval(timer);
    }
  }

  private async verifyFfmpeg(): Promise<void> {
    try {
      await this.media.assertFfmpegAvailable();
      this.logger.log(`ffmpeg is available via ${this.appConfig.ffmpegPath}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`ffmpeg preflight failed: ${message}`);
      await this.notifyOwner(`ffmpeg недоступен: ${message}`);
    }
  }

  private async discoverIngestVideos(): Promise<void> {
    const videos = await this.drive.listIngestVideosOldestFirst();
    for (const video of videos) {
      const existing = await this.prisma.videoJob.findUnique({
        where: { driveFileId: video.id },
      });
      if (existing) {
        continue;
      }

      const siblingText = await this.drive.findSiblingTextInIngest(video.name);
      const descriptionText = siblingText ? await this.drive.readTextFile(siblingText.id).catch(() => '') : '';
      const created = await this.prisma.videoJob.create({
        data: {
          driveFileId: video.id,
          fileName: video.name,
          createdTime: new Date(video.createdTime || Date.now()),
          status: siblingText ? VideoJobStatus.READY : VideoJobStatus.DISCOVERED,
          descriptionFileId: siblingText?.id,
          descriptionFileName: siblingText?.name,
          descriptionText: descriptionText || null,
        },
      });

      if (created.status === VideoJobStatus.READY) {
        await this.assignVideoSchedule(created.id, VideoJobStatus.READY);
      }
    }
  }

  private async processNextVideo(): Promise<void> {
    if (this.processingVideo) {
      return;
    }

    const job = await this.prisma.videoJob.findFirst({
      where: { status: VideoJobStatus.DISCOVERED },
      orderBy: { createdTime: 'asc' },
    });
    if (!job) {
      return;
    }

    this.processingVideo = true;
    await this.prisma.videoJob.update({
      where: { id: job.id },
      data: { status: VideoJobStatus.PROCESSING, lastError: null },
    });

    const tempVideoPath = await this.drive.downloadFile(job.driveFileId, job.fileName);

    try {
      const extracted = await this.media.extractSpeechAudio(tempVideoPath);
      try {
        const transcript = await this.ai.transcribeAudio(extracted.audioPath);
        const description = normalizeVideoDescription(await this.ai.generateVideoDescription(transcript, job.fileName));
        const textAsset = await this.drive.upsertIngestDescription(job.fileName, description);

        await this.prisma.videoJob.update({
          where: { id: job.id },
          data: {
            status: VideoJobStatus.READY,
            transcriptText: transcript,
            descriptionText: description,
            descriptionFileId: textAsset.id,
            descriptionFileName: textAsset.name,
            lastError: null,
          },
        });
        await this.assignVideoSchedule(job.id, VideoJobStatus.READY);
      } finally {
        await extracted.cleanup();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.prisma.videoJob.update({
        where: { id: job.id },
        data: {
          status: VideoJobStatus.PAUSED_FAILED,
          lastError: message,
        },
      });
      await this.notifyOwner(`Ошибка обработки видео ${job.fileName}: ${message}`);
    } finally {
      this.processingVideo = false;
      await unlink(tempVideoPath).catch(() => undefined);
    }
  }

  private async publishDueVideo(): Promise<void> {
    if (this.publishingVideo) {
      return;
    }

    const job = await this.prisma.videoJob.findFirst({
      where: {
        status: { in: [VideoJobStatus.READY, VideoJobStatus.RETRY_WAITING] },
        scheduledFor: { lte: new Date() },
      },
      orderBy: [{ scheduledFor: 'asc' }, { createdTime: 'asc' }],
    });
    if (!job) {
      return;
    }
    if (!this.uploader.isConfigured()) {
      return;
    }

    this.publishingVideo = true;
    await this.prisma.videoJob.update({
      where: { id: job.id },
      data: { status: VideoJobStatus.PUBLISHING },
    });

    try {
      const description = job.descriptionText?.trim()
        ? normalizeVideoDescription(job.descriptionText)
        : job.descriptionFileId
          ? normalizeVideoDescription(await this.drive.readTextFile(job.descriptionFileId))
          : '';
      if (!description.trim()) {
        throw new Error('Описание видео отсутствует');
      }

      const publishResult = await this.uploader.publish({
        videoUrl: await this.drive.getPublicVideoDownloadUrl(job.driveFileId),
        title: stripExtension(job.fileName),
        description,
      });

      const success = publishResult.status === 'completed' && publishResult.results.every((item) => item.success);
      if (!success) {
        throw new Error(
          publishResult.results
            .filter((item) => !item.success)
            .map((item) => `${item.platform}: ${item.message ?? 'unknown error'}`)
            .join('; ') || 'unknown publish failure',
        );
      }

      if (!job.descriptionFileId) {
        throw new Error('descriptionFileId is missing');
      }

      await this.drive.moveIngestAssetsToSent(job.driveFileId, job.descriptionFileId);
      await this.prisma.videoJob.update({
        where: { id: job.id },
        data: {
          status: VideoJobStatus.PUBLISHED,
          publishedAt: new Date(),
          lastError: null,
          lastPublishPayload: {
            title: stripExtension(job.fileName),
            description,
            platforms: this.appConfig.uploadPlatforms,
          },
          lastPublishResult: publishResult as unknown as object,
        },
      });

      await this.notionSync.handleVideoPublished(stripExtension(job.fileName));
      await this.notifyOwner(
        [
          `Видео опубликовано: ${job.fileName}`,
          `Время: ${new Date().toISOString()}`,
          `Платформы: ${this.appConfig.uploadPlatforms.join(', ')}`,
          `Описание:`,
          description,
          '',
          `Применённые поля: title, description, tiktok_title, youtube_title, youtube_description, instagram_title, instagram_first_comment, youtube_first_comment, media_type=REELS, share_to_feed=true, privacy_level=PUBLIC_TO_EVERYONE, privacyStatus=public, post_mode=DIRECT_POST, selfDeclaredMadeForKids=false, containsSyntheticMedia=false, defaultLanguage=ru, defaultAudioLanguage=ru-RU, is_aigc=false, async_upload=true, platform[]`,
          `Deferred: ${publishResult.deferred.join(' | ')}`,
        ].join('\n'),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const nextAttempts = job.publishAttempts + 1;
      const paused = nextAttempts >= 3;
      const nextSlot = nextPublishSlot(job.scheduledFor ?? new Date(), this.appConfig.publishWindows);

      await this.prisma.videoJob.update({
        where: { id: job.id },
        data: {
          status: paused ? VideoJobStatus.PAUSED_FAILED : VideoJobStatus.RETRY_WAITING,
          publishAttempts: nextAttempts,
          lastError: message,
          scheduledFor: paused ? job.scheduledFor : nextSlot,
          scheduledSlotKey: paused ? job.scheduledSlotKey : publishSlotKey(nextSlot, this.appConfig.timezone),
        },
      });

      await this.notifyOwner(
        `Ошибка публикации видео ${job.fileName}: ${message}${paused ? ' | Видео переведено в paused_failed' : ''}`,
      );
    } finally {
      this.publishingVideo = false;
    }
  }

  private async scanArticlesIfDue(): Promise<void> {
    if (this.scanningArticles || !this.appConfig.articleSources.length) {
      return;
    }

    const lastScanAt = await this.getDateState('articles:lastScanAt');
    if (lastScanAt && Date.now() - lastScanAt.getTime() < this.appConfig.articleScanIntervalMs) {
      return;
    }

    this.scanningArticles = true;
    try {
      const fetched = await this.articlePipeline.fetchArticles(this.appConfig.articleSources);
      const cutoff = new Date(Date.now() - this.appConfig.articleScanIntervalMs);
      const recentFetched = fetched.filter((item) => !item.publishedAt || item.publishedAt >= cutoff);
      const newRecords: ArticleRecord[] = [];

      for (const article of recentFetched) {
        const exists = await this.prisma.articleRecord.findUnique({
          where: { dedupeKey: article.dedupeKey },
        });
        if (exists) {
          continue;
        }
        const created = await this.prisma.articleRecord.create({
          data: {
            sourceName: article.sourceName,
            sourceUrl: article.sourceUrl,
            title: article.title,
            url: article.url,
            canonicalUrl: article.canonicalUrl,
            dedupeKey: article.dedupeKey,
            publishedAt: article.publishedAt,
            contentHash: article.contentHash,
            excerpt: article.excerpt,
            bodyText: article.bodyText,
          },
        });
        newRecords.push(created);
      }

      if (!newRecords.length) {
        return;
      }

      const clusterDto = await this.ai.buildCluster(newRecords);
      const cluster = await this.prisma.contentCluster.create({
        data: {
          title: clusterDto.title,
          summary: clusterDto.summary,
          sourceUrlsJson: JSON.stringify(clusterDto.sourceUrls),
          articleIdsJson: JSON.stringify(clusterDto.articleIds),
          fingerprint: sha256(clusterDto.fingerprint),
        },
      });

      await this.prisma.articleRecord.updateMany({
        where: { id: { in: newRecords.map((item) => item.id) } },
        data: { clusterId: cluster.id },
      });

      await this.createTelegramDraft(cluster.id, cluster.title, cluster.summary, clusterDto.sourceUrls);
      await this.createSocialDraft(cluster.id, cluster.title, cluster.summary, clusterDto.sourceUrls);
    } catch (error) {
      await this.notifyOwner(`Ошибка article scan: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await this.setDateState('articles:lastScanAt', new Date());
      this.scanningArticles = false;
    }
  }

  private async createTelegramDraft(
    clusterId: string,
    clusterTitle: string,
    summary: string,
    sourceUrls: string[],
  ): Promise<void> {
    const draft = await this.ai.generateTelegramDraft(summary, sourceUrls);
    const stem = this.makeStem(clusterTitle, clusterId);
    const textAsset = await this.drive.upsertTelegramDraftText(stem, draft.body);

    const created = await this.prisma.telegramDraft.create({
      data: {
        clusterId,
        title: draft.title,
        body: draft.body,
        textFileId: textAsset.id,
        sourceUrlsJson: JSON.stringify(sourceUrls),
        status: TelegramDraftStatus.PENDING_REVIEW,
      },
    });

    const ownerChatId = this.appConfig.telegramOwnerChatId;
    if (!ownerChatId) {
      return;
    }

    const previewMessageId = await this.telegram.sendDraftPreview({
      chatId: ownerChatId,
      draftId: created.id,
      title: created.title,
      body: created.body,
    });

    await this.prisma.telegramDraft.update({
      where: { id: created.id },
      data: {
        previewChatId: String(ownerChatId),
        previewMessageId: previewMessageId ? String(previewMessageId) : null,
      },
    });
  }

  private async createSocialDraft(
    clusterId: string,
    clusterTitle: string,
    summary: string,
    sourceUrls: string[],
  ): Promise<void> {
    const socialDraft = await this.ai.generateSocialDraft(summary, sourceUrls);
    const imagePrompt = await this.ai.generateImagePrompt(summary, socialDraft.body);
    const stem = this.makeStem(clusterTitle, clusterId);
    const textAsset = await this.drive.upsertWrittenText(stem, socialDraft.body);
    let imageAssetId: string | undefined;
    let imageMimeType: string | undefined;
    let status: SocialPublicationStatus = this.socialPublisher.isConfigured()
      ? SocialPublicationStatus.READY
      : SocialPublicationStatus.AWAITING_EXTERNAL_API_CONFIG;
    let lastError: string | null = null;

    if (this.ai.isConfigured()) {
      const generated = await this.ai.generate(imagePrompt);
      const imageAsset = await this.drive.uploadWrittenImage(stem, generated.bytes, generated.mimeType);
      imageAssetId = imageAsset.id;
      imageMimeType = generated.mimeType;
    } else {
      status = SocialPublicationStatus.FAILED;
      lastError = 'Image generation is not configured';
    }

    if (!imageAssetId) {
      status = SocialPublicationStatus.FAILED;
      lastError = lastError ?? 'Social publication image was not generated';
    }

    const scheduledFor = await this.nextSlotForSocial();
    await this.prisma.socialPublication.create({
      data: {
        clusterId,
        title: socialDraft.title,
        body: socialDraft.body,
        imagePrompt,
        imageFileId: imageAssetId,
        imageMimeType,
        textFileId: textAsset.id,
        folderStem: stem,
        scheduledFor,
        scheduledSlotKey: publishSlotKey(scheduledFor, this.appConfig.timezone),
        status,
        lastError,
      },
    });
  }

  private async publishDueSocial(): Promise<void> {
    if (this.publishingSocial || !this.socialPublisher.isConfigured()) {
      return;
    }

    const item = await this.prisma.socialPublication.findFirst({
      where: {
        status: SocialPublicationStatus.READY,
        scheduledFor: { lte: new Date() },
      },
      orderBy: [{ scheduledFor: 'asc' }, { createdAt: 'asc' }],
    });
    if (!item) {
      return;
    }

    this.publishingSocial = true;
    try {
      await this.prisma.socialPublication.update({
        where: { id: item.id },
        data: { status: SocialPublicationStatus.PUBLISHING },
      });

      const result = await this.socialPublisher.publish({
        title: item.title,
        body: item.body,
        imageFileId: item.imageFileId,
        imageMimeType: item.imageMimeType,
        textFileId: item.textFileId,
      });

      const successfulPlatforms = result.results.filter((row) => row.success);
      if (!successfulPlatforms.length) {
        throw new Error(
          result.results.map((row) => `${row.platform}: ${row.message ?? 'unknown error'}`).join('; ') ||
            'unknown social publish failure',
        );
      }

      if (!item.textFileId) {
        throw new Error('textFileId is missing');
      }

      await this.drive.moveWrittenAssetsToPublished(item.textFileId, item.imageFileId);
      await this.prisma.socialPublication.update({
        where: { id: item.id },
        data: {
          status: SocialPublicationStatus.PUBLISHED,
          publishedAt: new Date(),
          lastResult: result as unknown as object,
          lastError: null,
        },
      });

      const failedPlatforms = result.results.filter((row) => !row.success);
      await this.notifyOwner(
        [
          `Публикация social draft завершена: ${item.title}`,
          `Время: ${new Date().toISOString()}`,
          `Успешно: ${successfulPlatforms.map((row) => row.platform).join(', ')}`,
          failedPlatforms.length
            ? `С ошибками: ${failedPlatforms.map((row) => `${row.platform}: ${row.message ?? 'unknown error'}`).join(' | ')}`
            : 'Ошибок по платформам нет.',
        ].join('\n'),
      );
    } catch (error) {
      await this.prisma.socialPublication.update({
        where: { id: item.id },
        data: {
          status: SocialPublicationStatus.FAILED,
          lastError: error instanceof Error ? error.message : String(error),
        },
      });
      await this.notifyOwner(
        `Ошибка публикации social draft ${item.title}: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.publishingSocial = false;
    }
  }

  private async handleStart(chatId: number): Promise<void> {
    if (!this.dbReady) {
      await this.telegram.sendInfo(chatId, 'База данных не настроена. Проверьте DATABASE_URL.');
      return;
    }

    const [queueJobs, ingest, sent, written, published, drafts] = await Promise.all([
      this.prisma.videoJob.findMany({
        where: { status: { in: [VideoJobStatus.DISCOVERED, VideoJobStatus.PROCESSING, VideoJobStatus.READY, VideoJobStatus.RETRY_WAITING] } },
        orderBy: [{ createdTime: 'desc' }],
        take: 5,
      }),
      this.drive.listRecentVideos('ingest', 5),
      this.drive.listRecentVideos('sent', 5),
      this.drive.listRecentTextFiles('written', 5),
      this.drive.listRecentTextFiles('published', 5),
      this.prisma.telegramDraft.findMany({
        where: { status: TelegramDraftStatus.PENDING_REVIEW },
        orderBy: { createdAt: 'desc' },
        take: 5,
      }),
    ]);

    const lines = [
      'Статус: ok',
      `ffmpeg: ${this.appConfig.ffmpegPath}`,
      '',
      'Последние 5 видео в обработке/очереди:',
      ...this.formatList(queueJobs.map((item) => `${item.fileName} [${item.status}]`)),
      '',
      'INGEST:',
      ...this.formatList(ingest.map((item) => item.name)),
      '',
      'Sent:',
      ...this.formatList(sent.map((item) => item.name)),
      '',
      'Written:',
      ...this.formatList(written.map((item) => stripExtension(item.name))),
      '',
      'Published:',
      ...this.formatList(published.map((item) => stripExtension(item.name))),
      '',
      'Pending Telegram drafts:',
      ...this.formatList(drafts.map((item) => item.title)),
    ];

    await this.telegram.sendInfo(chatId, lines.join('\n'));
  }

  private async handleDraftPublish(draftId: string): Promise<void> {
    const draft = await this.prisma.telegramDraft.findUnique({ where: { id: draftId } });
    if (!draft || draft.status !== TelegramDraftStatus.PENDING_REVIEW) {
      return;
    }
    if (!this.appConfig.telegramChannelId) {
      throw new Error('TELEGRAM_CHANNEL_ID is missing');
    }

    const imageUrl = draft.imageFileId ? await this.drive.getPublicVideoDownloadUrl(draft.imageFileId) : undefined;
    const channelMessageId = await this.telegram.sendChannelPost(this.appConfig.telegramChannelId, draft.body, imageUrl);
    if (draft.previewChatId && draft.previewMessageId) {
      await this.telegram.deleteMessage(Number(draft.previewChatId), Number(draft.previewMessageId));
    }
    await this.closeEditSessions(draft.id);

    await this.prisma.telegramDraft.update({
      where: { id: draft.id },
      data: {
        status: TelegramDraftStatus.PUBLISHED,
        channelMessageId: channelMessageId ? String(channelMessageId) : null,
        publishedAt: new Date(),
      },
    });
  }

  private async handleDraftEdit(draftId: string): Promise<void> {
    const draft = await this.prisma.telegramDraft.findUnique({ where: { id: draftId } });
    if (!draft || !this.appConfig.telegramOwnerChatId) {
      return;
    }

    const existing = await this.prisma.editSession.findFirst({
      where: {
        ownerChatId: String(this.appConfig.telegramOwnerChatId),
        status: EditSessionStatus.ACTIVE,
      },
      orderBy: { createdAt: 'desc' },
    });
    if (existing?.promptMessageId) {
      await this.telegram.deleteMessage(this.appConfig.telegramOwnerChatId, Number(existing.promptMessageId));
      await this.prisma.editSession.update({
        where: { id: existing.id },
        data: { status: EditSessionStatus.CLOSED },
      });
    }

    const promptMessageId = await this.telegram.sendEditPrompt(this.appConfig.telegramOwnerChatId, draft.id);
    await this.prisma.editSession.create({
      data: {
        telegramDraftId: draft.id,
        ownerChatId: String(this.appConfig.telegramOwnerChatId),
        promptMessageId: promptMessageId ? String(promptMessageId) : null,
      },
    });
  }

  private async handleDraftDelete(draftId: string): Promise<void> {
    if (!this.appConfig.telegramOwnerChatId) {
      return;
    }
    await this.telegram.sendDeleteConfirmation(this.appConfig.telegramOwnerChatId, draftId);
  }

  private async handleDraftDeleteConfirm(draftId: string): Promise<void> {
    const draft = await this.prisma.telegramDraft.findUnique({ where: { id: draftId } });
    if (!draft) {
      return;
    }
    if (draft.previewChatId && draft.previewMessageId) {
      await this.telegram.deleteMessage(Number(draft.previewChatId), Number(draft.previewMessageId));
    }
    await this.closeEditSessions(draft.id);
    await this.prisma.telegramDraft.update({
      where: { id: draft.id },
      data: { status: TelegramDraftStatus.DELETED },
    });
  }

  private async handleDraftDeleteCancel(draftId: string): Promise<void> {
    await this.notifyOwner(`Удаление черновика отменено: ${draftId}`);
  }

  private async handleDraftRewrite(draftId: string): Promise<void> {
    const draft = await this.prisma.telegramDraft.findUnique({ where: { id: draftId } });
    if (!draft) {
      return;
    }
    const cluster = await this.prisma.contentCluster.findUnique({ where: { id: draft.clusterId } });
    if (!cluster) {
      return;
    }

    const sourceUrls = this.readJsonArray(draft.sourceUrlsJson);
    const rewritten = await this.ai.rewriteTelegramDraft(draft.body, cluster.summary, sourceUrls);
    const stem = this.makeStem(rewritten.title, cluster.id, draft.id);
    const textAsset = await this.drive.upsertTelegramDraftText(stem, rewritten.body);
    const created = await this.prisma.telegramDraft.create({
      data: {
        clusterId: draft.clusterId,
        title: rewritten.title,
        body: rewritten.body,
        textFileId: textAsset.id,
        sourceUrlsJson: draft.sourceUrlsJson,
        rewriteOfDraftId: draft.id,
        status: TelegramDraftStatus.PENDING_REVIEW,
      },
    });

    if (!this.appConfig.telegramOwnerChatId) {
      return;
    }
    const previewMessageId = await this.telegram.sendDraftPreview({
      chatId: this.appConfig.telegramOwnerChatId,
      draftId: created.id,
      title: created.title,
      body: created.body,
    });
    await this.prisma.telegramDraft.update({
      where: { id: created.id },
      data: {
        previewChatId: String(this.appConfig.telegramOwnerChatId),
        previewMessageId: previewMessageId ? String(previewMessageId) : null,
      },
    });
  }

  private async handleEditClose(draftId: string): Promise<void> {
    await this.closeEditSessions(draftId);
  }

  private async handleOwnerEditInput(payload: {
    chatId: number;
    messageId?: number;
    text?: string;
    photo?: { fileId: string; mimeType: string };
  }): Promise<void> {
    if (!this.appConfig.telegramOwnerChatId || payload.chatId !== this.appConfig.telegramOwnerChatId) {
      return;
    }

    const session = await this.prisma.editSession.findFirst({
      where: {
        ownerChatId: String(payload.chatId),
        status: EditSessionStatus.ACTIVE,
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!session) {
      return;
    }

    const draft = await this.prisma.telegramDraft.findUnique({ where: { id: session.telegramDraftId } });
    if (!draft) {
      return;
    }

    const stem = this.makeStem(draft.title, draft.clusterId, draft.id);
    let imageFileId = draft.imageFileId ?? undefined;
    let imageMimeType = draft.imageMimeType ?? undefined;

    if (payload.photo) {
      const downloaded = await this.telegram.downloadTelegramPhoto(payload.photo.fileId);
      const imageAsset = await this.drive.uploadTelegramDraftImage(
        stem,
        downloaded.bytes,
        downloaded.mimeType,
        draft.imageFileId ?? undefined,
      );
      imageFileId = imageAsset.id;
      imageMimeType = downloaded.mimeType;
    }

    const nextBody = payload.text?.trim() ? payload.text.trim() : draft.body;
    const textAsset = await this.drive.upsertTelegramDraftText(stem, nextBody, draft.textFileId ?? undefined);

    if (draft.previewChatId && draft.previewMessageId) {
      await this.telegram.deleteMessage(Number(draft.previewChatId), Number(draft.previewMessageId));
    }

    const imageUrl = imageFileId ? await this.drive.getPublicVideoDownloadUrl(imageFileId) : undefined;
    const previewMessageId = await this.telegram.sendDraftPreview({
      chatId: payload.chatId,
      draftId: draft.id,
      title: draft.title,
      body: nextBody,
      imageUrl,
    });

    await this.prisma.telegramDraft.update({
      where: { id: draft.id },
      data: {
        body: nextBody,
        textFileId: textAsset.id,
        imageFileId,
        imageMimeType,
        previewChatId: String(payload.chatId),
        previewMessageId: previewMessageId ? String(previewMessageId) : null,
      },
    });

    if (payload.messageId) {
      await this.telegram.deleteMessage(payload.chatId, payload.messageId);
    }
    if (session.promptMessageId) {
      await this.telegram.deleteMessage(payload.chatId, Number(session.promptMessageId));
    }
    await this.prisma.editSession.update({
      where: { id: session.id },
      data: { status: EditSessionStatus.CLOSED },
    });
  }

  private async assignVideoSchedule(jobId: string, status: VideoJobStatus): Promise<void> {
    const latest = await this.prisma.videoJob.findFirst({
      where: {
        id: { not: jobId },
        scheduledFor: { not: null },
        status: { in: [VideoJobStatus.READY, VideoJobStatus.RETRY_WAITING, VideoJobStatus.PUBLISHING, VideoJobStatus.PUBLISHED] },
      },
      orderBy: { scheduledFor: 'desc' },
    });

    const base = latest?.scheduledFor && latest.scheduledFor.getTime() > Date.now() ? latest.scheduledFor : new Date();
    const scheduledFor = nextPublishSlot(base, this.appConfig.publishWindows);
    await this.prisma.videoJob.update({
      where: { id: jobId },
      data: {
        status,
        scheduledFor,
        scheduledSlotKey: publishSlotKey(scheduledFor, this.appConfig.timezone),
      },
    });
  }

  private async nextSlotForSocial(): Promise<Date> {
    const latest = await this.prisma.socialPublication.findFirst({
      where: { scheduledFor: { not: null } },
      orderBy: { scheduledFor: 'desc' },
    });
    const base = latest?.scheduledFor && latest.scheduledFor.getTime() > Date.now() ? latest.scheduledFor : new Date();
    return nextPublishSlot(base, this.appConfig.publishWindows);
  }

  private formatList(items: string[]): string[] {
    if (!items.length) {
      return ['- пусто'];
    }
    return items.map((item) => `- ${truncate(item, 180)}`);
  }

  private async getDateState(key: string): Promise<Date | null> {
    const record = await this.prisma.appState.findUnique({ where: { key } });
    if (!record) {
      return null;
    }
    const date = new Date(record.value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  private async setDateState(key: string, value: Date): Promise<void> {
    await this.prisma.appState.upsert({
      where: { key },
      create: { key, value: value.toISOString() },
      update: { value: value.toISOString() },
    });
  }

  private async closeEditSessions(draftId: string): Promise<void> {
    const sessions = await this.prisma.editSession.findMany({
      where: {
        telegramDraftId: draftId,
        status: EditSessionStatus.ACTIVE,
      },
    });
    for (const session of sessions) {
      if (session.promptMessageId && this.appConfig.telegramOwnerChatId) {
        await this.telegram.deleteMessage(this.appConfig.telegramOwnerChatId, Number(session.promptMessageId));
      }
    }
    await this.prisma.editSession.updateMany({
      where: {
        telegramDraftId: draftId,
        status: EditSessionStatus.ACTIVE,
      },
      data: { status: EditSessionStatus.CLOSED },
    });
  }

  private makeStem(title: string, clusterId: string, suffix?: string): string {
    return `${slugify(title) || 'draft'}-${clusterId.slice(-6)}${suffix ? `-${suffix.slice(-4)}` : ''}`;
  }

  private readJsonArray(value: string): string[] {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
    } catch {
      return [];
    }
  }

  private async notifyOwner(text: string): Promise<void> {
    const ownerChatId = this.appConfig.telegramOwnerChatId;
    if (!ownerChatId) {
      return;
    }
    const messageId = await this.telegram.sendInfo(ownerChatId, text).catch(() => undefined);
    if (!this.dbReady) {
      return;
    }
    await this.prisma.notificationEvent.create({
      data: {
        kind: 'owner_notification',
        chatId: String(ownerChatId),
        messageId: messageId ? String(messageId) : null,
        payload: truncate(text, 4000),
      },
    });
  }

  private async safeRun(label: string, action: () => Promise<void>): Promise<void> {
    try {
      await action();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`${label} failed: ${message}`);
      await this.notifyOwner(`${label} failed: ${message}`);
    }
  }
}
