import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { basename } from 'node:path';
import { unlink } from 'node:fs/promises';

import { GoogleDriveService, DriveFileInfo } from './google-drive.service';
import { AiService } from './ai.service';
import { StateService } from './state.service';
import { TelegramBotService } from './telegram.service';
import { UploadService } from './upload.service';

interface PublishPair {
  video: DriveFileInfo;
  text: DriveFileInfo;
}

const STOP_REQUESTED_ERROR = '__STOP_REQUESTED__';

@Injectable()
export class AppService implements OnModuleInit {
  private readonly logger = new Logger(AppService.name);
  private readonly chatId: number | undefined;

  constructor(
    private readonly drive: GoogleDriveService,
    private readonly ai: AiService,
    private readonly state: StateService,
    private readonly telegram: TelegramBotService,
    private readonly uploader: UploadService,
    config: ConfigService,
  ) {
    this.chatId = this.parseNumber(config.get<string>('TELEGRAM_TARGET_CHAT_ID'));
  }

  async onModuleInit(): Promise<void> {
    await this.state.init();

    this.telegram.setHandlers({
      onStart: (chatId) => this.handleStart(chatId),
      onIngest: (chatId) => this.handleIngest(chatId),
      onPublishAll: (chatId, query) => this.handlePublishAll(chatId, query),
      onStop: (chatId) => this.handleStop(chatId),
      onPublishSingle: (chatId, resultVideoFileId) => this.handlePublishSingle(chatId, resultVideoFileId),
    });

    await this.telegram.start();
    await this.notify('Сервис запущен. Команды: /start /ingest /publish /stop');
  }

  private async handleStart(chatId: number): Promise<void> {
    try {
      const [ingestVideos, resultVideos, resultTexts, sentVideos] = await Promise.all([
        this.drive.listIngestVideosOldestFirst(),
        this.drive.listResultVideos(),
        this.drive.listResultTextFiles(),
        this.drive.listSentVideos(),
      ]);

      const runtime = this.state.getRuntime();
      const processingCount =
        runtime.activeProcess === 'idle' ? 0 : runtime.currentFileId ? Math.max(1, runtime.queue.length) : 0;
      const queueLines = runtime.queue.length
        ? runtime.queue.map((item, index) => `${index + 1}. ${item.name}`)
        : ['1. Очередь пуста'];

      const lines = [
        'Привет. Бот активен.',
        runtime.lastError ? `Ошибки: ${runtime.lastError}` : 'Ошибки: нет',
        '',
        `INGEST (видео): ${ingestVideos.length}`,
        `RESULT (видео): ${resultVideos.length}`,
        `SENT (видео): ${sentVideos.length}`,
        `RESULT (txt): ${resultTexts.length}`,
        '',
        `Последняя обработка: ${runtime.lastProcessedAt ?? 'нет'}`,
        `Последнее видео: ${runtime.lastProcessedName ?? 'нет'}`,
        '',
        `В обработке сейчас: ${processingCount}`,
        `Текущее: ${runtime.currentFileName ?? 'нет'}`,
        'Очередь:',
        ...queueLines,
      ];

      await this.telegram.sendInfo(chatId, lines.join('\n'));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.state.setLastError(message);
      await this.telegram.sendInfo(chatId, `Ошибка /start: ${message}`);
    }
  }

  private async handleIngest(chatId: number): Promise<void> {
    if (this.state.isBusy()) {
      const runtime = this.state.getRuntime();
      await this.telegram.sendInfo(
        chatId,
        `Сейчас уже идет процесс: ${runtime.activeProcess}. Для остановки используй /stop`,
      );
      return;
    }

    try {
      const ingestVideos = await this.drive.listIngestVideosOldestFirst();
      if (!ingestVideos.length) {
        await this.telegram.sendInfo(chatId, 'В папке INGEST нет видео для обработки.');
        return;
      }

      const queue: DriveFileInfo[] = ingestVideos;

      this.state.startProcess(
        'ingest',
        queue.map((item) => ({ id: item.id, name: item.name })),
      );

      await this.telegram.sendInfo(chatId, `Запускаю ingest. В очереди: ${queue.length}.`);

      void this.runIngestQueue(queue, chatId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.state.setLastError(message);
      this.state.finishProcess();
      await this.telegram.sendInfo(chatId, `Не удалось запустить ingest: ${message}`);
    }
  }

  private async runIngestQueue(queue: DriveFileInfo[], chatId: number): Promise<void> {
    try {
      for (const file of queue) {
        if (this.state.isStopRequested()) {
          await this.telegram.sendInfo(chatId, '⏹ Обработка остановлена командой /stop');
          break;
        }

        this.state.setCurrent(file.id, file.name);

        try {
          const resultVideoId = await this.processSingleIngest(file);
          this.state.setLastProcessed(file.name);
          this.state.setLastError(null);
          this.state.shiftQueue(file.id);

          await this.telegram.sendInfo(chatId, `✅ Обработка завершена: ${file.name}`);
          await this.telegram.sendPublishButton(chatId, resultVideoId, file.name);
        } catch (err) {
          if (err instanceof Error && err.message === STOP_REQUESTED_ERROR) {
            await this.telegram.sendInfo(chatId, '⏹ Обработка остановлена командой /stop');
            break;
          }

          const message = err instanceof Error ? err.message : String(err);
          this.state.setLastError(message);
          this.logger.error(`Processing failed for ${file.name}: ${message}`);
          await this.telegram.sendInfo(chatId, `❌ Ошибка обработки ${file.name}: ${message}`);
          break;
        }
      }
    } finally {
      this.state.finishProcess();
    }
  }

  private async processSingleIngest(file: DriveFileInfo): Promise<string> {
    this.ensureNotStopped();
    const tempPath = await this.drive.downloadFile(file.id, file.name);
    let txtFileId: string | undefined;

    try {
      this.ensureNotStopped();
      const transcript = await this.ai.transcribeVideo(tempPath);

      this.ensureNotStopped();
      const caption = await this.ai.generateDescription(transcript, file.name);

      this.ensureNotStopped();
      const txtName = this.txtName(file.name);
      const txt = await this.drive.uploadTextFile(txtName, caption);
      txtFileId = txt.id;

      this.ensureNotStopped();
      const moved = await this.drive.moveIngestVideoToResult(file.id, tempPath, file.name);
      return moved.id;
    } catch (err) {
      if (txtFileId) {
        await this.drive.deleteFile(txtFileId).catch(() => undefined);
      }
      throw err;
    } finally {
      await unlink(tempPath).catch(() => undefined);
    }
  }

  private async handlePublishAll(chatId: number, query?: string): Promise<void> {
    if (this.state.isBusy()) {
      const runtime = this.state.getRuntime();
      await this.telegram.sendInfo(
        chatId,
        `Сейчас уже идет процесс: ${runtime.activeProcess}. Для остановки используй /stop`,
      );
      return;
    }

    try {
      if (!query?.trim()) {
        await this.telegram.sendInfo(chatId, 'Укажи название: /publish <название видео>');
        return;
      }
      const pairs = await this.getPublishPairs();
      const pair = this.findBestPairByQuery(pairs, query);
      if (!pair) {
        await this.telegram.sendInfo(chatId, `Не найдено видео для публикации по запросу: ${query}`);
        return;
      }

      this.state.startProcess('publish', [{ id: pair.video.id, name: pair.video.name }]);

      await this.telegram.sendInfo(chatId, `Запускаю публикацию: ${pair.video.name}`);
      void this.runPublishQueue([pair], chatId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.state.setLastError(message);
      this.state.finishProcess();
      await this.telegram.sendInfo(chatId, `Не удалось запустить publish: ${message}`);
    }
  }

  private async handlePublishSingle(chatId: number, resultVideoFileId: string): Promise<void> {
    if (this.state.isBusy()) {
      const runtime = this.state.getRuntime();
      await this.telegram.sendInfo(
        chatId,
        `Сейчас уже идет процесс: ${runtime.activeProcess}. Для остановки используй /stop`,
      );
      return;
    }

    try {
      const pair = await this.getPairForVideoId(resultVideoFileId);
      if (!pair) {
        await this.telegram.sendInfo(chatId, 'Для выбранного видео не найдено описание .txt в RESULT.');
        return;
      }

      this.state.startProcess('publish', [{ id: pair.video.id, name: pair.video.name }]);
      await this.telegram.sendInfo(chatId, `Запускаю публикацию одного видео: ${pair.video.name}`);
      void this.runPublishQueue([pair], chatId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.state.setLastError(message);
      this.state.finishProcess();
      await this.telegram.sendInfo(chatId, `Ошибка publish_one: ${message}`);
    }
  }

  private async runPublishQueue(pairs: PublishPair[], chatId: number): Promise<void> {
    try {
      for (const pair of pairs) {
        if (this.state.isStopRequested()) {
          await this.telegram.sendInfo(chatId, '⏹ Публикация остановлена командой /stop');
          break;
        }

        this.state.setCurrent(pair.video.id, pair.video.name);

        try {
          await this.publishPair(pair);
          this.state.setLastError(null);
          this.state.shiftQueue(pair.video.id);
          await this.telegram.sendInfo(chatId, `✅ Опубликовано: ${pair.video.name}`);
        } catch (err) {
          if (err instanceof Error && err.message === STOP_REQUESTED_ERROR) {
            await this.telegram.sendInfo(chatId, '⏹ Публикация остановлена командой /stop');
            break;
          }

          const message = err instanceof Error ? err.message : String(err);
          this.state.setLastError(message);
          this.logger.error(`Publish failed for ${pair.video.name}: ${message}`);
          await this.telegram.sendInfo(chatId, `❌ Ошибка публикации ${pair.video.name}: ${message}`);
          break;
        }
      }
    } finally {
      this.state.finishProcess();
    }
  }

  private async publishPair(pair: PublishPair): Promise<void> {
    this.ensureNotStopped();
    try {
      this.ensureNotStopped();
      this.logger.log(`Publish stage=read_caption_start file=${pair.video.name} txtId=${pair.text.id}`);
      const caption = await this.drive.readTextFile(pair.text.id);
      if (!caption.trim()) {
        throw new Error(`Описание пустое: ${pair.text.name}`);
      }
      this.logger.log(`Publish stage=read_caption_done file=${pair.video.name} captionLength=${caption.length}`);

      this.ensureNotStopped();
      this.logger.log(`Publish stage=prepare_public_url_start file=${pair.video.name}`);
      const publicUrl = await this.drive.getPublicVideoDownloadUrl(pair.video.id);
      this.logger.log(`Publish stage=prepare_public_url_done file=${pair.video.name} url=${publicUrl}`);

      this.logger.log(`Publish stage=api_upload_start source=url file=${pair.video.name}`);
      try {
        await this.uploader.publishFromUrl(publicUrl, basename(pair.video.name), caption);
        this.logger.log(`Publish stage=api_upload_done source=url file=${pair.video.name}`);
      } catch (urlErr) {
        const urlErrMessage = urlErr instanceof Error ? urlErr.message : String(urlErr);
        if (urlErrMessage.includes('Upload status timeout:')) {
          this.logger.error(
            `Publish via URL timed out for ${pair.video.name}. Keep single async request alive; fallback to file is skipped.`,
          );
          throw new Error(urlErrMessage);
        }
        this.logger.warn(
          `Publish via URL failed for ${pair.video.name}: ${urlErrMessage}. Fallback to file upload.`,
        );

        this.ensureNotStopped();
        this.logger.log(`Publish stage=download_start file=${pair.video.name} videoId=${pair.video.id}`);
        const tempPath = await this.drive.downloadFile(pair.video.id, pair.video.name);
        this.logger.log(`Publish stage=download_done file=${pair.video.name} localPath=${tempPath}`);

        try {
          this.logger.log(`Publish stage=api_upload_start source=file file=${pair.video.name}`);
          await this.uploader.publishFromFile(tempPath, basename(pair.video.name), caption);
          this.logger.log(`Publish stage=api_upload_done source=file file=${pair.video.name}`);
        } finally {
          await unlink(tempPath).catch(() => undefined);
          this.logger.log(`Publish stage=cleanup_done file=${pair.video.name}`);
        }
      }

      this.ensureNotStopped();
      this.logger.log(`Publish stage=move_to_sent_start file=${pair.video.name}`);
      await this.drive.moveResultAssetsToSent(pair.video.id, pair.text.id);
      this.logger.log(`Publish stage=move_to_sent_done file=${pair.video.name}`);
    } finally {
      this.logger.log(`Publish stage=finalize_done file=${pair.video.name}`);
    }
  }

  private async handleStop(chatId: number): Promise<void> {
    if (!this.state.isBusy()) {
      await this.telegram.sendInfo(chatId, 'Активных процессов нет.');
      return;
    }

    this.state.requestStop();
    await this.telegram.sendInfo(chatId, 'Команда /stop принята. Останавливаю процесс и очищаю очередь.');
  }

  private async getPublishPairs(): Promise<PublishPair[]> {
    const [videos, texts] = await Promise.all([
      this.drive.listResultVideos(),
      this.drive.listResultTextFiles(),
    ]);

    const textByBase = new Map<string, DriveFileInfo>();
    for (const text of texts) {
      textByBase.set(this.baseName(text.name).toLowerCase(), text);
    }

    return videos
      .sort((a, b) => a.createdTime.localeCompare(b.createdTime))
      .map((video) => ({ video, text: this.pickBestTextForVideo(video, texts, textByBase) }))
      .filter((pair): pair is PublishPair => Boolean(pair.text));
  }

  private async getPairForVideoId(videoId: string): Promise<PublishPair | null> {
    const [videos, texts] = await Promise.all([this.drive.listResultVideos(), this.drive.listResultTextFiles()]);
    const video = videos.find((item) => item.id === videoId);
    if (!video) {
      return null;
    }

    const textByBase = new Map<string, DriveFileInfo>();
    for (const text of texts) {
      textByBase.set(this.normalizeName(this.baseName(text.name)), text);
    }
    const text = this.pickBestTextForVideo(video, texts, textByBase);
    if (!text) {
      return null;
    }
    return { video, text };
  }

  private pickBestTextForVideo(
    video: DriveFileInfo,
    texts: DriveFileInfo[],
    textByBase: Map<string, DriveFileInfo>,
  ): DriveFileInfo | undefined {
    const exact = textByBase.get(this.normalizeName(this.baseName(video.name)));
    if (exact) {
      return exact;
    }

    const scored = texts
      .map((text) => ({
        text,
        score: this.scoreNameMatch(this.baseName(video.name), this.baseName(text.name)),
      }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || a.text.createdTime.localeCompare(b.text.createdTime));

    return scored[0]?.text;
  }

  private findBestPairByQuery(pairs: PublishPair[], query: string): PublishPair | null {
    const scored = pairs
      .map((pair) => ({
        pair,
        score: this.scoreNameMatch(query, pair.video.name),
      }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || a.pair.video.createdTime.localeCompare(b.pair.video.createdTime));

    return scored[0]?.pair ?? null;
  }

  private scoreNameMatch(queryRaw: string, targetRaw: string): number {
    const query = this.normalizeName(this.baseName(queryRaw));
    const target = this.normalizeName(this.baseName(targetRaw));
    if (!query || !target) {
      return 0;
    }
    if (query === target) {
      return 1000;
    }
    if (target.startsWith(query)) {
      return 800 + query.length;
    }
    if (target.includes(query)) {
      return 700 + query.length;
    }

    const queryTokens = query.split(' ').filter(Boolean);
    const targetTokens = new Set(target.split(' ').filter(Boolean));
    const overlap = queryTokens.filter((token) => targetTokens.has(token)).length;
    if (!overlap) {
      return 0;
    }
    return overlap * 100 + Math.min(query.length, target.length);
  }

  private normalizeName(value: string): string {
    return value
      .toLowerCase()
      .replace(/ё/g, 'е')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private baseName(name: string): string {
    return name.replace(/\.[^.]+$/, '');
  }

  private txtName(name: string): string {
    return `${this.baseName(name)}.txt`;
  }

  private ensureNotStopped(): void {
    if (this.state.isStopRequested()) {
      throw new Error(STOP_REQUESTED_ERROR);
    }
  }

  private async notify(text: string): Promise<void> {
    if (!this.chatId) {
      return;
    }
    await this.telegram.sendInfo(this.chatId, text).catch((err) => {
      this.logger.warn(`Telegram notify failed: ${err}`);
    });
  }

  private parseNumber(value: string | undefined): number | undefined {
    if (!value) {
      return undefined;
    }
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : undefined;
  }
}
