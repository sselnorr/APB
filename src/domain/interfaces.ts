export interface ArticleSourceConfig {
  name: string;
  url: string;
  type: 'rss' | 'html' | 'telegram' | 'x';
}

export interface ContentClusterDto {
  title: string;
  summary: string;
  sourceUrls: string[];
  articleIds: string[];
  fingerprint: string;
}

export interface DraftContent {
  title: string;
  body: string;
  imagePrompt?: string;
}

export interface PublisherAdapter<TPayload = unknown, TResult = unknown> {
  isConfigured(): boolean;
  publish(payload: TPayload): Promise<TResult>;
}

export interface ImageGeneratorAdapter {
  isConfigured(): boolean;
  generate(prompt: string): Promise<{ mimeType: string; bytes: Buffer }>;
}

export interface DriveAssetStore {
  listIngestVideosOldestFirst(): Promise<DriveAssetInfo[]>;
  listRecentFiles(folder: DriveFolderKey, limit: number): Promise<DriveAssetInfo[]>;
  downloadFile(fileId: string, nameHint?: string): Promise<string>;
}

export interface DriveAssetInfo {
  id: string;
  name: string;
  mimeType: string;
  createdTime: string;
}

export type DriveFolderKey = 'ingest' | 'sent' | 'written' | 'published' | 'tgDrafts';
