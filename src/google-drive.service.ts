import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { google, drive_v3 } from 'googleapis';
import { createPrivateKey, createSign } from 'node:crypto';
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import { join } from 'node:path';
import { v4 as uuid } from 'uuid';

export interface DriveFileInfo {
  id: string;
  name: string;
  mimeType: string;
  createdTime: string;
}

@Injectable()
export class GoogleDriveService {
  private readonly logger = new Logger(GoogleDriveService.name);
  private oauthDrive?: drive_v3.Drive;
  private serviceDrive?: drive_v3.Drive;
  private serviceDriveInit?: Promise<drive_v3.Drive | undefined>;
  private serviceAccountDisabledReason?: string;
  private readonly folderId: string;
  private readonly resultFolderId: string;
  private readonly sentFolderId: string;
  private readonly downloadDir: string;

  private readonly accessToken?: string;
  private readonly clientId?: string;
  private readonly clientSecret?: string;
  private readonly refreshToken?: string;
  private readonly oauthClientJson?: string;
  private readonly oauthClientJsonBase64?: string;
  private readonly serviceAccountKeyPath?: string;
  private readonly serviceAccountKeyJson?: string;
  private readonly serviceAccountKeyJsonBase64?: string;
  private readonly sourceByFileId = new Map<string, 'oauth' | 'service'>();
  private readonly folderDriveIdCache = new Map<string, string | null>();

  constructor(private readonly config: ConfigService) {
    this.folderId = this.clean(this.config.get<string>('GOOGLE_DRIVE_FOLDER_ID')) ?? '';
    this.resultFolderId = this.clean(this.config.get<string>('GOOGLE_DRIVE_RESULT_FOLDER_ID')) ?? '';
    this.sentFolderId = this.clean(this.config.get<string>('GOOGLE_DRIVE_SENT_FOLDER_ID')) ?? '';
    this.downloadDir = this.clean(this.config.get<string>('GOOGLE_DRIVE_DOWNLOAD_DIR')) ?? 'downloads/videos';

    this.accessToken = this.clean(this.config.get<string>('GOOGLE_DRIVE_ACCESS_TOKEN'));
    this.clientId = this.clean(this.config.get<string>('GOOGLE_DRIVE_CLIENT_ID'));
    this.clientSecret = this.clean(this.config.get<string>('GOOGLE_DRIVE_CLIENT_SECRET'));
    this.refreshToken = this.clean(this.config.get<string>('GOOGLE_DRIVE_REFRESH_TOKEN'));
    this.oauthClientJson = this.clean(this.config.get<string>('GOOGLE_DRIVE_OAUTH_CLIENT_JSON'));
    this.oauthClientJsonBase64 = this.clean(this.config.get<string>('GOOGLE_DRIVE_OAUTH_CLIENT_JSON_BASE64'));
    this.serviceAccountKeyPath = this.clean(this.config.get<string>('GOOGLE_DRIVE_SERVICE_ACCOUNT_KEY_PATH'));
    this.serviceAccountKeyJson = this.clean(this.config.get<string>('GOOGLE_DRIVE_SERVICE_ACCOUNT_KEY_JSON'));
    this.serviceAccountKeyJsonBase64 = this.clean(
      this.config.get<string>('GOOGLE_DRIVE_SERVICE_ACCOUNT_KEY_JSON_BASE64'),
    );
  }

  async listIngestVideosOldestFirst(): Promise<DriveFileInfo[]> {
    if (!this.folderId) {
      return [];
    }

    const merged = new Map<string, DriveFileInfo>();
    for (const client of await this.getIngestClients()) {
      try {
        const files = await this.listFolderFilesByDrive(client.drive, this.folderId, 'video');
        this.logger.log(`INGEST scan via ${client.kind}: ${files.length} video(s)`);
        for (const file of files) {
          merged.set(file.id, file);
          this.sourceByFileId.set(file.id, client.kind);
        }
      } catch (err) {
        this.handleDriveClientFailure(client.kind, err);
        this.logger.warn(`INGEST scan failed via ${client.kind}: ${err}`);
      }
    }

    return Array.from(merged.values()).sort((a, b) => a.createdTime.localeCompare(b.createdTime));
  }

  async listResultVideos(): Promise<DriveFileInfo[]> {
    return this.listFolderFilesMerged(this.resultFolderId, 'video');
  }

  async listSentVideos(): Promise<DriveFileInfo[]> {
    return this.listFolderFilesMerged(this.sentFolderId, 'video');
  }

  async listResultTextFiles(): Promise<DriveFileInfo[]> {
    return this.listFolderFilesMerged(this.resultFolderId, 'text');
  }

  async downloadFile(fileId: string, nameHint?: string): Promise<string> {
    await fs.mkdir(this.downloadDir, { recursive: true });
    const safeName = nameHint ?? `${fileId}-${uuid()}.bin`;
    const targetPath = join(this.downloadDir, safeName);

    for (const client of await this.getIngestClientsByPriority(fileId)) {
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
      } catch (err) {
        this.handleDriveClientFailure(client.kind, err);
        this.logger.warn(`Download failed via ${client.kind} for ${fileId}: ${err}`);
      }
    }

    throw new Error(`Cannot download file ${fileId} from available Drive clients.`);
  }

  async uploadTextFile(name: string, content: string): Promise<{ id: string; link: string }> {
    const drive = await this.getOAuthDrive();
    const res = await drive.files.create({
      requestBody: {
        name,
        parents: this.resultFolderId ? [this.resultFolderId] : undefined,
        mimeType: 'text/plain',
      },
      media: { mimeType: 'text/plain', body: content },
      fields: 'id',
      supportsAllDrives: true,
    });

    const id = res.data.id;
    if (!id) {
      throw new Error('Drive did not return id for text file upload');
    }
    return { id, link: this.fileLink(id) };
  }

  async readTextFile(fileId: string): Promise<string> {
    const drive = await this.getOAuthDrive();
    const response = await drive.files.get(
      { fileId, alt: 'media', supportsAllDrives: true },
      { responseType: 'text' },
    );
    return String(response.data ?? '');
  }

  async getPublicVideoDownloadUrl(fileId: string): Promise<string> {
    await this.makePublic(fileId);

    for (const client of await this.getIngestClientsByPriority(fileId)) {
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
        if (!this.looksLikeVideo(file.name ?? '', file.mimeType ?? '')) {
          throw new Error(`File is not video: ${file.name ?? fileId}`);
        }
        if (file.webContentLink) {
          return file.webContentLink;
        }
      } catch (err) {
        this.handleDriveClientFailure(client.kind, err);
        this.logger.warn(`Cannot get webContentLink via ${client.kind} for ${fileId}: ${err}`);
      }
    }

    return `https://drive.google.com/uc?export=download&id=${encodeURIComponent(fileId)}`;
  }

  async deleteFile(fileId: string): Promise<void> {
    const drive = await this.getOAuthDrive();
    await drive.files.delete({ fileId, supportsAllDrives: true });
  }

  async moveIngestVideoToResult(
    fileId: string,
    localVideoPath: string,
    originalName: string,
  ): Promise<{ id: string; link: string }> {
    if (!this.folderId || !this.resultFolderId) {
      throw new Error('GOOGLE_DRIVE_FOLDER_ID and GOOGLE_DRIVE_RESULT_FOLDER_ID are required.');
    }

    for (const client of await this.getIngestClientsByPriority(fileId)) {
      try {
        await this.moveFileBetweenFolders(client.drive, fileId, this.folderId, this.resultFolderId);
        this.logger.log(`Moved INGEST file via ${client.kind}: ${fileId}`);
        return { id: fileId, link: this.fileLink(fileId) };
      } catch (err) {
        this.handleDriveClientFailure(client.kind, err);
        this.logger.warn(`Direct move failed via ${client.kind} for ${fileId}: ${err}`);
      }
    }

    const oauth = await this.getOAuthDrive();
    const uploaded = await oauth.files.create({
      requestBody: {
        name: originalName,
        parents: [this.resultFolderId],
        mimeType: this.videoMimeByName(originalName),
      },
      media: {
        mimeType: this.videoMimeByName(originalName),
        body: createReadStream(localVideoPath),
      },
      fields: 'id',
      supportsAllDrives: true,
    });

    const newId = uploaded.data.id;
    if (!newId) {
      throw new Error('Fallback upload to RESULT returned empty file id.');
    }

    try {
      await this.deleteSourceFromIngest(fileId);
      this.logger.log(`Fallback move completed with reupload: ${fileId} -> ${newId}`);
      return { id: newId, link: this.fileLink(newId) };
    } catch (err) {
      await oauth.files.delete({ fileId: newId, supportsAllDrives: true }).catch(() => undefined);
      throw err;
    }
  }

  async moveResultAssetsToSent(videoFileId: string, txtFileId: string): Promise<void> {
    if (!this.resultFolderId || !this.sentFolderId) {
      throw new Error('GOOGLE_DRIVE_RESULT_FOLDER_ID and GOOGLE_DRIVE_SENT_FOLDER_ID are required.');
    }
    await this.moveFileBetweenFoldersAnyClient(videoFileId, this.resultFolderId, this.sentFolderId);
    await this.moveFileBetweenFoldersAnyClient(txtFileId, this.resultFolderId, this.sentFolderId);
  }

  fileLink(fileId: string): string {
    return `https://drive.google.com/file/d/${fileId}/view?usp=sharing`;
  }

  private async listFolderFilesByDrive(
    drive: drive_v3.Drive,
    folderId: string,
    kind: 'video' | 'text',
  ): Promise<DriveFileInfo[]> {
    if (!folderId) {
      return [];
    }
    const driveId = await this.getFolderDriveId(drive, folderId);
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'files(id,name,mimeType,createdTime)',
      pageSize: 1000,
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      orderBy: 'createdTime asc',
      corpora: driveId ? 'drive' : 'allDrives',
      driveId: driveId ?? undefined,
    });

    const files = res.data.files ?? [];
    return files
      .filter((file) => Boolean(file.id && file.name))
      .filter((file) => {
        if (kind === 'video') {
          return this.looksLikeVideo(file.name as string, file.mimeType ?? '');
        }
        return this.looksLikeText(file.name as string, file.mimeType ?? '');
      })
      .map((file) => ({
        id: file.id as string,
        name: file.name as string,
        mimeType: file.mimeType ?? '',
        createdTime: file.createdTime ?? '',
      }));
  }

  private async getFolderDriveId(drive: drive_v3.Drive, folderId: string): Promise<string | null> {
    if (this.folderDriveIdCache.has(folderId)) {
      return this.folderDriveIdCache.get(folderId) ?? null;
    }

    try {
      const meta = await drive.files.get({
        fileId: folderId,
        fields: 'id,driveId',
        supportsAllDrives: true,
      });
      const driveId = meta.data.driveId ?? null;
      this.folderDriveIdCache.set(folderId, driveId);
      return driveId;
    } catch {
      this.folderDriveIdCache.set(folderId, null);
      return null;
    }
  }

  private async listFolderFilesMerged(folderId: string, kind: 'video' | 'text'): Promise<DriveFileInfo[]> {
    if (!folderId) {
      return [];
    }

    const merged = new Map<string, DriveFileInfo>();
    for (const client of await this.getIngestClients()) {
      try {
        const files = await this.listFolderFilesByDrive(client.drive, folderId, kind);
        for (const file of files) {
          merged.set(file.id, file);
          this.sourceByFileId.set(file.id, client.kind);
        }
      } catch (err) {
        this.handleDriveClientFailure(client.kind, err);
        this.logger.warn(`Folder scan failed via ${client.kind} for ${folderId}: ${err}`);
      }
    }

    return Array.from(merged.values()).sort((a, b) => a.createdTime.localeCompare(b.createdTime));
  }

  private async getOAuthDrive(): Promise<drive_v3.Drive> {
    if (this.oauthDrive) {
      return this.oauthDrive;
    }
    const oauthClient = this.readOAuthClientCredentials();
    const clientId = this.clientId ?? oauthClient?.clientId;
    const clientSecret = this.clientSecret ?? oauthClient?.clientSecret;

    if (!clientId || !clientSecret || !this.refreshToken) {
      throw new Error('Google Drive OAuth credentials are missing.');
    }

    const oauth2 = new google.auth.OAuth2(clientId, clientSecret);
    oauth2.setCredentials({
      refresh_token: this.refreshToken,
      access_token: this.accessToken,
    });

    try {
      const token = await oauth2.getAccessToken();
      if (!token.token) {
        throw new Error('OAuth refresh returned empty access token');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
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
    if (!this.serviceAccountKeyJson && !this.serviceAccountKeyJsonBase64 && !this.serviceAccountKeyPath) {
      return undefined;
    }

    this.serviceDriveInit = this.createServiceDrive();
    return this.serviceDriveInit;
  }

  private async getIngestClients(): Promise<Array<{ kind: 'oauth' | 'service'; drive: drive_v3.Drive }>> {
    const clients: Array<{ kind: 'oauth' | 'service'; drive: drive_v3.Drive }> = [];
    const service = await this.getServiceDrive();
    if (service) {
      clients.push({ kind: 'service', drive: service });
    }
    try {
      clients.push({ kind: 'oauth', drive: await this.getOAuthDrive() });
    } catch (err) {
      this.logger.warn(`OAuth client unavailable for INGEST: ${err}`);
    }
    if (!clients.length) {
      throw new Error('No Drive client available for INGEST.');
    }
    return clients;
  }

  private async getIngestClientsByPriority(
    fileId: string,
  ): Promise<Array<{ kind: 'oauth' | 'service'; drive: drive_v3.Drive }>> {
    const clients = await this.getIngestClients();
    const preferred = this.sourceByFileId.get(fileId);
    if (!preferred) {
      return clients;
    }
    return clients.sort((a, b) => {
      if (a.kind === preferred && b.kind !== preferred) return -1;
      if (b.kind === preferred && a.kind !== preferred) return 1;
      return 0;
    });
  }

  private async deleteSourceFromIngest(fileId: string): Promise<void> {
    let lastError: string | undefined;
    for (const client of await this.getIngestClientsByPriority(fileId)) {
      try {
        await client.drive.files.delete({ fileId, supportsAllDrives: true });
        return;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Delete source failed via ${client.kind} for ${fileId}: ${lastError}`);
      }
    }
    throw new Error(`Cannot delete source file ${fileId} from INGEST. Last error: ${lastError ?? 'unknown'}`);
  }

  private async makePublic(fileId: string): Promise<void> {
    for (const client of await this.getIngestClientsByPriority(fileId)) {
      try {
        await client.drive.permissions.create({
          fileId,
          requestBody: { role: 'reader', type: 'anyone' },
          supportsAllDrives: true,
        });
        return;
      } catch (err) {
        this.logger.warn(`Failed to set public permission via ${client.kind} for ${fileId}: ${err}`);
      }
    }
  }

  private async moveFileBetweenFoldersAnyClient(
    fileId: string,
    fromFolderId: string,
    toFolderId: string,
  ): Promise<void> {
    let lastError: string | undefined;
    for (const client of await this.getIngestClientsByPriority(fileId)) {
      try {
        await this.moveFileBetweenFolders(client.drive, fileId, fromFolderId, toFolderId);
        this.logger.log(`Moved file ${fileId} via ${client.kind}: ${fromFolderId} -> ${toFolderId}`);
        return;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Move failed via ${client.kind} for ${fileId}: ${lastError}`);
      }
    }

    throw new Error(
      `Cannot move file ${fileId} from ${fromFolderId} to ${toFolderId}. Last error: ${lastError ?? 'unknown'}`,
    );
  }

  private clean(value: string | undefined): string | undefined {
    if (!value) {
      return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  private readOAuthClientCredentials(): { clientId: string; clientSecret: string } | undefined {
    const raw = this.oauthClientJson ?? this.decodeBase64(this.oauthClientJsonBase64);
    if (!raw) {
      return undefined;
    }

    const parsed = JSON.parse(raw) as {
      installed?: { client_id?: string; client_secret?: string };
      web?: { client_id?: string; client_secret?: string };
    };
    const client = parsed.installed ?? parsed.web;
    if (!client?.client_id || !client.client_secret) {
      throw new Error('Google OAuth client JSON must include client_id and client_secret.');
    }

    return {
      clientId: client.client_id,
      clientSecret: client.client_secret,
    };
  }

  private async readServiceAccountCredentials(): Promise<Record<string, unknown>> {
    const raw =
      this.serviceAccountKeyJson ??
      this.decodeBase64(this.serviceAccountKeyJsonBase64) ??
      (this.serviceAccountKeyPath ? await fs.readFile(this.serviceAccountKeyPath, 'utf8') : undefined);

    if (!raw) {
      throw new Error('Google service account credentials are missing.');
    }

    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const privateKey = typeof parsed.private_key === 'string' ? this.normalizePrivateKey(parsed.private_key) : undefined;
    const clientEmail = typeof parsed.client_email === 'string' ? parsed.client_email.trim() : undefined;

    if (!privateKey) {
      throw new Error('Google service account JSON must include private_key.');
    }
    if (!clientEmail) {
      throw new Error('Google service account JSON must include client_email.');
    }

    this.assertServiceAccountPrivateKey(privateKey);

    return {
      ...parsed,
      private_key: privateKey,
      client_email: clientEmail,
    };
  }

  private decodeBase64(value: string | undefined): string | undefined {
    if (!value) {
      return undefined;
    }
    return Buffer.from(value, 'base64').toString('utf8');
  }

  private async createServiceDrive(): Promise<drive_v3.Drive | undefined> {
    try {
      const scopes = ['https://www.googleapis.com/auth/drive'];
      const credentials = await this.readServiceAccountCredentials();
      const auth = new google.auth.GoogleAuth({ credentials, scopes });

      await auth.getClient();

      this.serviceDrive = google.drive({ version: 'v3', auth });
      this.logger.warn('Using Google Drive service account credentials for INGEST fallback');
      return this.serviceDrive;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.disableServiceAccountFallback(message);
      return undefined;
    }
  }

  private normalizePrivateKey(value: string): string {
    return value
      .trim()
      .replace(/^"|"$/g, '')
      .replace(/\r\n/g, '\n')
      .replace(/\\n/g, '\n');
  }

  private assertServiceAccountPrivateKey(privateKey: string): void {
    try {
      const keyObject = createPrivateKey({ key: privateKey, format: 'pem' });
      const sign = createSign('RSA-SHA256');
      sign.update('google-drive-service-account-validation');
      sign.end();
      sign.sign(keyObject);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Invalid service account private_key format: ${message}`);
    }
  }

  private handleDriveClientFailure(kind: 'oauth' | 'service', err: unknown): void {
    if (kind !== 'service') {
      return;
    }

    const message = err instanceof Error ? err.message : String(err);
    if (this.looksLikeServiceAccountKeyError(message)) {
      this.disableServiceAccountFallback(message);
    }
  }

  private disableServiceAccountFallback(reason: string): void {
    if (this.serviceAccountDisabledReason) {
      return;
    }

    this.serviceAccountDisabledReason = reason;
    this.serviceDrive = undefined;
    this.serviceDriveInit = Promise.resolve(undefined);

    if (this.hasOAuthCredentialsConfigured()) {
      this.logger.debug(`Service account fallback disabled: ${reason}`);
      return;
    }

    this.logger.warn(`Service account fallback disabled: ${reason}`);
  }

  private looksLikeServiceAccountKeyError(message: string): boolean {
    const normalized = message.toLowerCase();
    return (
      normalized.includes('decoder routines') ||
      normalized.includes('pem routines') ||
      normalized.includes('asn1') ||
      normalized.includes('private key') ||
      normalized.includes('invalid_grant')
    );
  }

  private hasOAuthCredentialsConfigured(): boolean {
    const oauthClient = this.readOAuthClientCredentials();
    const clientId = this.clientId ?? oauthClient?.clientId;
    const clientSecret = this.clientSecret ?? oauthClient?.clientSecret;

    return Boolean(clientId && clientSecret && this.refreshToken);
  }

  private looksLikeVideo(name: string, mimeType: string): boolean {
    if (mimeType.startsWith('video/')) {
      return true;
    }
    const lower = name.toLowerCase();
    return ['.mp4', '.mov', '.m4v', '.avi', '.mkv', '.webm'].some((ext) => lower.endsWith(ext));
  }

  private looksLikeText(name: string, mimeType: string): boolean {
    if (mimeType === 'text/plain') {
      return true;
    }
    return name.toLowerCase().endsWith('.txt');
  }

  private videoMimeByName(name: string): string {
    const lower = name.toLowerCase();
    if (lower.endsWith('.mov')) return 'video/quicktime';
    if (lower.endsWith('.webm')) return 'video/webm';
    if (lower.endsWith('.mkv')) return 'video/x-matroska';
    if (lower.endsWith('.avi')) return 'video/x-msvideo';
    if (lower.endsWith('.m4v')) return 'video/x-m4v';
    return 'video/mp4';
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

}
