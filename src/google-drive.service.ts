import { Injectable, Logger } from '@nestjs/common';
import { google, drive_v3 } from 'googleapis';
import { createPrivateKey, createSign } from 'node:crypto';
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import { Readable } from 'node:stream';
import { join } from 'node:path';
import { v4 as uuid } from 'uuid';
import { AppConfigService } from './app.config';
import { DriveAssetInfo, DriveAssetStore, DriveFolderKey } from './domain/interfaces';

type DriveClientKind = 'oauth' | 'service';

@Injectable()
export class GoogleDriveService implements DriveAssetStore {
  private readonly logger = new Logger(GoogleDriveService.name);
  private oauthDrive?: drive_v3.Drive;
  private serviceDrive?: drive_v3.Drive;
  private serviceDriveInit?: Promise<drive_v3.Drive | undefined>;
  private serviceAccountDisabledReason?: string;
  private readonly sourceByFileId = new Map<string, DriveClientKind>();
  private readonly folderMetaCache = new Map<string, { id: string; driveId: string | null }>();

  constructor(private readonly appConfig: AppConfigService) {}

  async listIngestVideosOldestFirst(): Promise<DriveAssetInfo[]> {
    return this.listFolderFilesMerged(this.appConfig.ingestFolderId, 'video');
  }

  async listRecentFiles(folder: DriveFolderKey, limit: number): Promise<DriveAssetInfo[]> {
    const folderId = this.getFolderId(folder);
    const files = await this.listFolderFilesMerged(folderId, 'any');
    return files.slice(-limit).reverse();
  }

  async listRecentVideos(folder: DriveFolderKey, limit: number): Promise<DriveAssetInfo[]> {
    const folderId = this.getFolderId(folder);
    const files = await this.listFolderFilesMerged(folderId, 'video');
    return files.slice(-limit).reverse();
  }

  async listRecentTextFiles(folder: DriveFolderKey, limit: number): Promise<DriveAssetInfo[]> {
    const folderId = this.getFolderId(folder);
    const files = await this.listFolderFilesMerged(folderId, 'text');
    return files.slice(-limit).reverse();
  }

  async downloadFile(fileId: string, nameHint?: string): Promise<string> {
    await fs.mkdir(this.appConfig.downloadDir, { recursive: true });
    const safeName = nameHint ?? `${fileId}-${uuid()}.bin`;
    const targetPath = join(this.appConfig.downloadDir, safeName);

    for (const client of await this.getClientsByPriority(fileId)) {
      try {
        const response = await client.drive.files.get(
          { fileId, alt: 'media', supportsAllDrives: true },
          { responseType: 'stream' },
        );
        await new Promise<void>((resolve, reject) => {
          if (!response.data) {
            reject(new Error('No data stream'));
            return;
          }
          const dest = createWriteStream(targetPath);
          response.data.on('error', reject).on('end', resolve).pipe(dest);
        });
        this.sourceByFileId.set(fileId, client.kind);
        return targetPath;
      } catch (error) {
        this.handleDriveClientFailure(client.kind, error);
        this.logger.warn(`Download failed via ${client.kind} for ${fileId}: ${error}`);
      }
    }

    throw new Error(`Cannot download file ${fileId} from Google Drive`);
  }

  async readTextFile(fileId: string): Promise<string> {
    for (const client of await this.getClientsByPriority(fileId)) {
      try {
        const response = await client.drive.files.get(
          { fileId, alt: 'media', supportsAllDrives: true },
          { responseType: 'text' },
        );
        return String(response.data ?? '');
      } catch (error) {
        this.handleDriveClientFailure(client.kind, error);
      }
    }

    throw new Error(`Cannot read text file ${fileId}`);
  }

  async upsertIngestDescription(videoName: string, content: string): Promise<DriveAssetInfo> {
    return this.upsertTextFileByName('ingest', `${this.stripExtension(videoName)}.txt`, content);
  }

  async upsertTelegramDraftText(stem: string, content: string, existingFileId?: string): Promise<DriveAssetInfo> {
    return this.upsertTextFile('tgDrafts', `${stem}.txt`, content, existingFileId);
  }

  async upsertWrittenText(stem: string, content: string, existingFileId?: string): Promise<DriveAssetInfo> {
    return this.upsertTextFile('written', `${stem}.txt`, content, existingFileId);
  }

  async uploadTelegramDraftImage(
    stem: string,
    bytes: Buffer,
    mimeType: string,
    existingFileId?: string,
  ): Promise<DriveAssetInfo> {
    return this.upsertBinaryFile('tgDrafts', `${stem}${this.extensionByMime(mimeType)}`, bytes, mimeType, existingFileId);
  }

  async uploadWrittenImage(
    stem: string,
    bytes: Buffer,
    mimeType: string,
    existingFileId?: string,
  ): Promise<DriveAssetInfo> {
    return this.upsertBinaryFile('written', `${stem}${this.extensionByMime(mimeType)}`, bytes, mimeType, existingFileId);
  }

  async moveIngestAssetsToSent(videoFileId: string, textFileId: string): Promise<void> {
    await this.moveFileBetweenFoldersAnyClient(videoFileId, this.appConfig.ingestFolderId, this.appConfig.sentFolderId);
    await this.moveFileBetweenFoldersAnyClient(textFileId, this.appConfig.ingestFolderId, this.appConfig.sentFolderId);
  }

  async moveWrittenAssetsToPublished(textFileId: string, imageFileId?: string | null): Promise<void> {
    await this.moveFileBetweenFoldersAnyClient(
      textFileId,
      this.appConfig.writtenFolderId,
      this.appConfig.publishedFolderId,
    );
    if (imageFileId) {
      await this.moveFileBetweenFoldersAnyClient(
        imageFileId,
        this.appConfig.writtenFolderId,
        this.appConfig.publishedFolderId,
      );
    }
  }

  async deleteFile(fileId: string): Promise<void> {
    for (const client of await this.getClientsByPriority(fileId)) {
      try {
        await client.drive.files.delete({ fileId, supportsAllDrives: true });
        return;
      } catch (error) {
        this.handleDriveClientFailure(client.kind, error);
      }
    }

    throw new Error(`Cannot delete file ${fileId}`);
  }

  async getPublicVideoDownloadUrl(fileId: string): Promise<string> {
    await this.makePublic(fileId);

    for (const client of await this.getClientsByPriority(fileId)) {
      try {
        const meta = await client.drive.files.get({
          fileId,
          fields: 'id,webContentLink,mimeType,name',
          supportsAllDrives: true,
        });
        const file = meta.data;
        if (!file.id) {
          continue;
        }
        if (file.webContentLink) {
          return file.webContentLink;
        }
      } catch (error) {
        this.handleDriveClientFailure(client.kind, error);
      }
    }

    return `https://drive.google.com/uc?export=download&id=${encodeURIComponent(fileId)}`;
  }

  async findSiblingTextInIngest(videoName: string): Promise<DriveAssetInfo | null> {
    const targetName = `${this.stripExtension(videoName)}.txt`;
    return this.findFileByName(this.appConfig.ingestFolderId, targetName);
  }

  private async upsertTextFile(
    folder: DriveFolderKey,
    fileName: string,
    content: string,
    existingFileId?: string,
  ): Promise<DriveAssetInfo> {
    const folderId = this.getFolderId(folder);

    if (existingFileId) {
      return this.updateExistingFile(existingFileId, fileName, 'text/plain', () => Readable.from([content]));
    }

    const existing = await this.findFileByName(folderId, fileName);
    if (existing) {
      return this.updateExistingFile(existing.id, fileName, 'text/plain', () => Readable.from([content]));
    }

    return this.createFile(folderId, fileName, 'text/plain', () => Readable.from([content]));
  }

  private async upsertTextFileByName(folder: DriveFolderKey, fileName: string, content: string): Promise<DriveAssetInfo> {
    return this.upsertTextFile(folder, fileName, content);
  }

  private async upsertBinaryFile(
    folder: DriveFolderKey,
    fileName: string,
    bytes: Buffer,
    mimeType: string,
    existingFileId?: string,
  ): Promise<DriveAssetInfo> {
    const folderId = this.getFolderId(folder);

    if (existingFileId) {
      return this.updateExistingFile(existingFileId, fileName, mimeType, () => Readable.from(bytes));
    }

    const existing = await this.findFileByName(folderId, fileName);
    if (existing) {
      return this.updateExistingFile(existing.id, fileName, mimeType, () => Readable.from(bytes));
    }

    return this.createFile(folderId, fileName, mimeType, () => Readable.from(bytes));
  }

  private async createFile(
    folderId: string,
    fileName: string,
    mimeType: string,
    bodyFactory: () => Readable,
  ): Promise<DriveAssetInfo> {
    const errors: string[] = [];
    for (const client of await this.getDriveClients()) {
      try {
        const parentId = await this.resolveFolderId(client.drive, folderId);
        const response = await client.drive.files.create({
          requestBody: {
            name: fileName,
            parents: [parentId],
            mimeType,
          },
          media: { mimeType, body: bodyFactory() },
          fields: 'id,name,mimeType,createdTime',
          supportsAllDrives: true,
        });
        const created = response.data;
        if (!created.id || !created.name) {
          throw new Error('Drive create returned empty id');
        }
        return {
          id: created.id,
          name: created.name,
          mimeType: created.mimeType ?? mimeType,
          createdTime: created.createdTime ?? new Date().toISOString(),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${client.kind}: ${message}`);
        this.handleDriveClientFailure(client.kind, error);
      }
    }

    throw new Error(`Cannot create file ${fileName}: ${errors.join(' | ') || 'unknown'}`);
  }

  private async updateExistingFile(
    fileId: string,
    fileName: string,
    mimeType: string,
    bodyFactory: () => Readable,
  ): Promise<DriveAssetInfo> {
    const errors: string[] = [];
    for (const client of await this.getClientsByPriority(fileId)) {
      try {
        const response = await client.drive.files.update({
          fileId,
          requestBody: { name: fileName, mimeType },
          media: { mimeType, body: bodyFactory() },
          fields: 'id,name,mimeType,createdTime',
          supportsAllDrives: true,
        });
        const updated = response.data;
        if (!updated.id || !updated.name) {
          throw new Error('Drive update returned empty id');
        }
        return {
          id: updated.id,
          name: updated.name,
          mimeType: updated.mimeType ?? mimeType,
          createdTime: updated.createdTime ?? new Date().toISOString(),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${client.kind}: ${message}`);
        this.handleDriveClientFailure(client.kind, error);
      }
    }

    throw new Error(`Cannot update file ${fileName}: ${errors.join(' | ') || 'unknown'}`);
  }

  private async findFileByName(folderId: string, fileName: string): Promise<DriveAssetInfo | null> {
    const escapedName = fileName.replace(/'/g, "\\'");
    const targetFolderId = this.resolveRawFolderId(folderId);
    for (const client of await this.getDriveClients()) {
      try {
        const folderTarget = await this.resolveFolderTarget(client.drive, targetFolderId);
        const q = `'${folderTarget.id}' in parents and trashed = false and name = '${escapedName}'`;
        const files = await this.listFilesPaged(client.drive, {
          q,
          fields: 'files(id,name,mimeType,createdTime)',
          includeItemsFromAllDrives: true,
          supportsAllDrives: true,
          corpora: folderTarget.driveId ? 'drive' : 'allDrives',
          driveId: folderTarget.driveId ?? undefined,
          pageSize: 10,
        });
        const file = files[0];
        if (file?.id && file.name) {
          return {
            id: file.id,
            name: file.name,
            mimeType: file.mimeType ?? '',
            createdTime: file.createdTime ?? new Date().toISOString(),
          };
        }
      } catch (error) {
        this.handleDriveClientFailure(client.kind, error);
      }
    }
    return null;
  }

  private async moveFileBetweenFoldersAnyClient(fileId: string, fromFolderId: string, toFolderId: string): Promise<void> {
    let lastError = 'unknown';
    for (const client of await this.getClientsByPriority(fileId)) {
      try {
        const resolvedFrom = await this.resolveFolderId(client.drive, fromFolderId);
        const resolvedTo = await this.resolveFolderId(client.drive, toFolderId);
        await this.moveFileBetweenFolders(client.drive, fileId, resolvedFrom, resolvedTo);
        return;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        this.handleDriveClientFailure(client.kind, error);
      }
    }

    throw new Error(`Cannot move file ${fileId}: ${lastError}`);
  }

  private async listFolderFilesMerged(folderId: string, kind: 'video' | 'text' | 'any'): Promise<DriveAssetInfo[]> {
    const merged = new Map<string, DriveAssetInfo>();
    for (const client of await this.getDriveClients()) {
      try {
        const files = await this.listFolderFilesByDrive(client.drive, folderId, kind);
        for (const file of files) {
          merged.set(file.id, file);
          this.sourceByFileId.set(file.id, client.kind);
        }
      } catch (error) {
        this.handleDriveClientFailure(client.kind, error);
      }
    }
    return Array.from(merged.values()).sort((a, b) => a.createdTime.localeCompare(b.createdTime));
  }

  private async listFolderFilesByDrive(
    drive: drive_v3.Drive,
    folderId: string,
    kind: 'video' | 'text' | 'any',
  ): Promise<DriveAssetInfo[]> {
    const target = await this.resolveFolderTarget(drive, folderId);
    const q = `'${target.id}' in parents and trashed = false`;
    const files = await this.listFilesPaged(drive, {
      q,
      fields: 'nextPageToken,files(id,name,mimeType,createdTime)',
      pageSize: 1000,
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      orderBy: 'createdTime asc',
      corpora: target.driveId ? 'drive' : 'allDrives',
      driveId: target.driveId ?? undefined,
    });

    return files
      .filter((file) => Boolean(file.id && file.name))
      .filter((file) => {
        if (kind === 'video') {
          return this.looksLikeVideo(file.name as string, file.mimeType ?? '');
        }
        if (kind === 'text') {
          return this.looksLikeText(file.name as string, file.mimeType ?? '');
        }
        return true;
      })
      .map((file) => ({
        id: file.id as string,
        name: file.name as string,
        mimeType: file.mimeType ?? '',
        createdTime: file.createdTime ?? '',
      }));
  }

  private async makePublic(fileId: string): Promise<void> {
    for (const client of await this.getClientsByPriority(fileId)) {
      try {
        await client.drive.permissions.create({
          fileId,
          requestBody: { role: 'reader', type: 'anyone' },
          supportsAllDrives: true,
        });
        return;
      } catch (error) {
        this.handleDriveClientFailure(client.kind, error);
      }
    }
  }

  private async moveFileBetweenFolders(
    drive: drive_v3.Drive,
    fileId: string,
    fromFolderId: string,
    toFolderId: string,
  ): Promise<void> {
    const meta = await drive.files.get({
      fileId,
      fields: 'parents',
      supportsAllDrives: true,
    });
    const parents = meta.data.parents ?? [];
    const removeParents = fromFolderId && parents.includes(fromFolderId) ? fromFolderId : parents.join(',');
    await drive.files.update({
      fileId,
      addParents: toFolderId,
      removeParents: removeParents || undefined,
      supportsAllDrives: true,
    });
  }

  private async listFilesPaged(
    drive: drive_v3.Drive,
    params: drive_v3.Params$Resource$Files$List,
  ): Promise<drive_v3.Schema$File[]> {
    const all: drive_v3.Schema$File[] = [];
    let pageToken: string | undefined;
    do {
      const response = await drive.files.list({ ...params, pageToken });
      all.push(...(response.data.files ?? []));
      pageToken = response.data.nextPageToken ?? undefined;
    } while (pageToken);
    return all;
  }

  private async getDriveClients(): Promise<Array<{ kind: DriveClientKind; drive: drive_v3.Drive }>> {
    const clients: Array<{ kind: DriveClientKind; drive: drive_v3.Drive }> = [];
    const service = await this.getServiceDrive();
    if (service) {
      clients.push({ kind: 'service', drive: service });
    }
    try {
      const oauth = await this.getOAuthDrive();
      clients.push({ kind: 'oauth', drive: oauth });
    } catch (error) {
      this.logger.warn(`OAuth Drive unavailable: ${error}`);
    }
    if (!clients.length) {
      throw new Error('No Google Drive client available');
    }
    return clients;
  }

  private async getClientsByPriority(
    fileId: string,
  ): Promise<Array<{ kind: DriveClientKind; drive: drive_v3.Drive }>> {
    const clients = await this.getDriveClients();
    const preferred = this.sourceByFileId.get(fileId);
    if (!preferred) {
      return clients;
    }
    return clients.sort((left, right) => {
      if (left.kind === preferred && right.kind !== preferred) return -1;
      if (right.kind === preferred && left.kind !== preferred) return 1;
      return 0;
    });
  }

  private async getOAuthDrive(): Promise<drive_v3.Drive> {
    if (this.oauthDrive) {
      return this.oauthDrive;
    }

    const clientId = this.clean(process.env.GOOGLE_DRIVE_CLIENT_ID);
    const clientSecret = this.clean(process.env.GOOGLE_DRIVE_CLIENT_SECRET);
    const refreshToken = this.clean(process.env.GOOGLE_DRIVE_REFRESH_TOKEN);
    if (!clientId || !clientSecret || !refreshToken) {
      throw new Error('Google Drive OAuth credentials are missing');
    }

    const oauth2 = new google.auth.OAuth2(clientId, clientSecret);
    oauth2.setCredentials({
      refresh_token: refreshToken,
    });

    try {
      const token = await oauth2.getAccessToken();
      if (!token.token) {
        throw new Error('OAuth refresh returned empty access token');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Google Drive OAuth initialization failed: ${message}`);
    }

    this.oauthDrive = google.drive({ version: 'v3', auth: oauth2 });
    return this.oauthDrive;
  }

  private async getServiceDrive(): Promise<drive_v3.Drive | undefined> {
    if (this.serviceDrive) {
      return this.serviceDrive;
    }
    if (this.serviceDriveInit) {
      return this.serviceDriveInit;
    }
    if (this.serviceAccountDisabledReason) {
      return undefined;
    }

    this.serviceDriveInit = this.createServiceDrive();
    return this.serviceDriveInit;
  }

  private async createServiceDrive(): Promise<drive_v3.Drive | undefined> {
    const raw =
      this.clean(process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_KEY_JSON) ??
      this.decodeBase64(this.clean(process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_KEY_JSON_BASE64)) ??
      (this.clean(process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_KEY_PATH)
        ? await fs.readFile(this.clean(process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_KEY_PATH) as string, 'utf8')
        : undefined);

    if (!raw) {
      return undefined;
    }

    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const privateKey = typeof parsed.private_key === 'string' ? this.normalizePrivateKey(parsed.private_key) : undefined;
      const clientEmail = typeof parsed.client_email === 'string' ? parsed.client_email.trim() : undefined;
      if (!privateKey || !clientEmail) {
        throw new Error('Service account JSON must include private_key and client_email');
      }
      this.assertServiceAccountPrivateKey(privateKey);
      const auth = new google.auth.GoogleAuth({
        credentials: {
          ...parsed,
          private_key: privateKey,
          client_email: clientEmail,
        },
        scopes: ['https://www.googleapis.com/auth/drive'],
      });
      await auth.getClient();
      this.serviceDrive = google.drive({ version: 'v3', auth });
      return this.serviceDrive;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.serviceAccountDisabledReason = message;
      this.logger.warn(`Service account disabled: ${message}`);
      return undefined;
    }
  }

  private handleDriveClientFailure(kind: DriveClientKind, error: unknown): void {
    if (kind !== 'service') {
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    const normalized = message.toLowerCase();
    if (
      normalized.includes('private key') ||
      normalized.includes('invalid_grant') ||
      normalized.includes('asn1') ||
      normalized.includes('pem')
    ) {
      this.serviceAccountDisabledReason = message;
      this.serviceDrive = undefined;
      this.serviceDriveInit = Promise.resolve(undefined);
    }
  }

  private async resolveFolderTarget(
    drive: drive_v3.Drive,
    folderId: string,
  ): Promise<{ id: string; driveId: string | null }> {
    const resolvedId = this.resolveRawFolderId(folderId);
    if (this.folderMetaCache.has(resolvedId)) {
      return this.folderMetaCache.get(resolvedId) as { id: string; driveId: string | null };
    }

    try {
      const meta = await drive.files.get({
        fileId: resolvedId,
        fields: 'id,driveId,mimeType,shortcutDetails',
        supportsAllDrives: true,
      });
      const mimeType = meta.data.mimeType ?? '';
      if (
        mimeType === 'application/vnd.google-apps.shortcut' &&
        meta.data.shortcutDetails?.targetId &&
        meta.data.shortcutDetails.targetMimeType === 'application/vnd.google-apps.folder'
      ) {
        const targetId = meta.data.shortcutDetails.targetId;
        const targetMeta = await drive.files.get({
          fileId: targetId,
          fields: 'id,driveId',
          supportsAllDrives: true,
        });
        const shortcutResolved = { id: targetId, driveId: targetMeta.data.driveId ?? null };
        this.folderMetaCache.set(resolvedId, shortcutResolved);
        return shortcutResolved;
      }
      const resolved = { id: resolvedId, driveId: meta.data.driveId ?? null };
      this.folderMetaCache.set(resolvedId, resolved);
      return resolved;
    } catch {
      const fallback = { id: resolvedId, driveId: null };
      this.folderMetaCache.set(resolvedId, fallback);
      return fallback;
    }
  }

  private async resolveFolderId(drive: drive_v3.Drive, folderId: string): Promise<string> {
    const target = await this.resolveFolderTarget(drive, folderId);
    return target.id;
  }

  private getFolderId(folder: DriveFolderKey): string {
    switch (folder) {
      case 'ingest':
        return this.appConfig.ingestFolderId;
      case 'sent':
        return this.appConfig.sentFolderId;
      case 'written':
        return this.appConfig.writtenFolderId;
      case 'published':
        return this.appConfig.publishedFolderId;
      case 'tgDrafts':
        return this.appConfig.tgDraftsFolderId;
    }
  }

  private resolveRawFolderId(value: string): string {
    return value.trim();
  }

  private clean(value: string | undefined): string | undefined {
    if (!value) {
      return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length ? trimmed : undefined;
  }

  private decodeBase64(value: string | undefined): string | undefined {
    if (!value) {
      return undefined;
    }
    return Buffer.from(value, 'base64').toString('utf8');
  }

  private normalizePrivateKey(value: string): string {
    const normalized = value
      .trim()
      .replace(/^"|"$/g, '')
      .replace(/^'|'$/g, '')
      .replace(/\r\n/g, '\n')
      .replace(/\\n/g, '\n');
    const begin = '-----BEGIN PRIVATE KEY-----';
    const end = '-----END PRIVATE KEY-----';
    if (!normalized.includes(begin) || !normalized.includes(end)) {
      return normalized;
    }
    const body = normalized
      .slice(normalized.indexOf(begin) + begin.length, normalized.indexOf(end))
      .replace(/[\s\r\n]+/g, '')
      .match(/.{1,64}/g)
      ?.join('\n');
    return `${begin}\n${body ?? ''}\n${end}`;
  }

  private assertServiceAccountPrivateKey(privateKey: string): void {
    try {
      const keyObject = createPrivateKey({ key: privateKey, format: 'pem' });
      const sign = createSign('RSA-SHA256');
      sign.update('apb-drive-validation');
      sign.end();
      sign.sign(keyObject);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid service account private_key format: ${message}`);
    }
  }

  private looksLikeVideo(name: string, mimeType: string): boolean {
    if (mimeType.startsWith('video/')) {
      return true;
    }
    const lower = name.toLowerCase();
    return ['.mp4', '.mov', '.m4v', '.avi', '.mkv', '.webm'].some((ext) => lower.endsWith(ext));
  }

  private looksLikeText(name: string, mimeType: string): boolean {
    return mimeType === 'text/plain' || name.toLowerCase().endsWith('.txt');
  }

  private extensionByMime(mimeType: string): string {
    if (mimeType === 'image/png') return '.png';
    if (mimeType === 'image/webp') return '.webp';
    return '.jpg';
  }

  private stripExtension(fileName: string): string {
    return fileName.replace(/\.[^.]+$/, '');
  }
}
