import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { google, drive_v3 } from 'googleapis';
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
  private readonly folderId: string;
  private readonly resultFolderId: string;
  private readonly sentFolderId: string;
  private readonly downloadDir: string;

  private readonly accessToken?: string;
  private readonly clientId?: string;
  private readonly clientSecret?: string;
  private readonly refreshToken?: string;
  private readonly serviceAccountKeyPath?: string;
  private readonly serviceAccountKeyJson?: string;
  private readonly sourceByFileId = new Map<string, 'oauth' | 'service'>();

  constructor(private readonly config: ConfigService) {
    this.folderId = this.clean(this.config.get<string>('GOOGLE_DRIVE_FOLDER_ID')) ?? '';
    this.resultFolderId = this.clean(this.config.get<string>('GOOGLE_DRIVE_RESULT_FOLDER_ID')) ?? '';
    this.sentFolderId = this.clean(this.config.get<string>('GOOGLE_DRIVE_SENT_FOLDER_ID')) ?? '';
    this.downloadDir = this.clean(this.config.get<string>('GOOGLE_DRIVE_DOWNLOAD_DIR')) ?? 'downloads/videos';

    this.accessToken = this.clean(this.config.get<string>('GOOGLE_DRIVE_ACCESS_TOKEN'));
    this.clientId = this.clean(this.config.get<string>('GOOGLE_DRIVE_CLIENT_ID'));
    this.clientSecret = this.clean(this.config.get<string>('GOOGLE_DRIVE_CLIENT_SECRET'));
    this.refreshToken = this.clean(this.config.get<string>('GOOGLE_DRIVE_REFRESH_TOKEN'));
    this.serviceAccountKeyPath = this.clean(this.config.get<string>('GOOGLE_DRIVE_SERVICE_ACCOUNT_KEY_PATH'));
    this.serviceAccountKeyJson = this.clean(this.config.get<string>('GOOGLE_DRIVE_SERVICE_ACCOUNT_KEY_JSON'));
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
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'files(id,name,mimeType,createdTime)',
      pageSize: 1000,
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      orderBy: 'createdTime asc',
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
        this.logger.warn(`Folder scan failed via ${client.kind} for ${folderId}: ${err}`);
      }
    }

    return Array.from(merged.values()).sort((a, b) => a.createdTime.localeCompare(b.createdTime));
  }

  private async getOAuthDrive(): Promise<drive_v3.Drive> {
    if (this.oauthDrive) {
      return this.oauthDrive;
    }
    if (!this.clientId || !this.clientSecret || !this.refreshToken) {
      throw new Error('Google Drive OAuth credentials are missing.');
    }

    const oauth2 = new google.auth.OAuth2(this.clientId, this.clientSecret);
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
    if (!this.serviceAccountKeyJson && !this.serviceAccountKeyPath) {
      return undefined;
    }

    const scopes = ['https://www.googleapis.com/auth/drive'];
    const credentials = this.serviceAccountKeyJson
      ? JSON.parse(this.serviceAccountKeyJson)
      : JSON.parse(await fs.readFile(this.serviceAccountKeyPath as string, 'utf8'));
    const auth = new google.auth.GoogleAuth({ credentials, scopes });
    this.serviceDrive = google.drive({ version: 'v3', auth });
    this.logger.warn('Using Google Drive service account credentials for INGEST fallback');
    return this.serviceDrive;
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
