import { Injectable } from '@nestjs/common';
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';

export type ActiveProcess = 'idle' | 'ingest' | 'publish';

export interface RuntimeState {
  activeProcess: ActiveProcess;
  currentFileId: string | null;
  currentFileName: string | null;
  queue: Array<{ id: string; name: string }>;
  stopRequested: boolean;
  lastProcessedAt: string | null;
  lastProcessedName: string | null;
  lastError: string | null;
}

interface DBData {
  runtime: RuntimeState;
}

const DEFAULT_RUNTIME: RuntimeState = {
  activeProcess: 'idle',
  currentFileId: null,
  currentFileName: null,
  queue: [],
  stopRequested: false,
  lastProcessedAt: null,
  lastProcessedName: null,
  lastError: null,
};

@Injectable()
export class StateService {
  private readonly db: Low<DBData>;

  constructor() {
    const dataDir = join(process.cwd(), 'data');
    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true });
    }
    const file = join(dataDir, 'state.json');
    const adapter = new JSONFile<DBData>(file);
    this.db = new Low<DBData>(adapter, {
      runtime: { ...DEFAULT_RUNTIME },
    });
  }

  async init(): Promise<void> {
    await this.db.read();
    this.db.data ??= {
      runtime: { ...DEFAULT_RUNTIME },
    };
    this.db.data.runtime = this.normalizeRuntime(this.db.data.runtime);
    await this.db.write();
  }

  getRuntime(): RuntimeState {
    return this.normalizeRuntime(this.db.data?.runtime);
  }

  isBusy(): boolean {
    const process = this.getRuntime().activeProcess;
    return process === 'ingest' || process === 'publish';
  }

  startProcess(process: Exclude<ActiveProcess, 'idle'>, queue: Array<{ id: string; name: string }>): void {
    if (!this.db.data) {
      return;
    }
    this.db.data.runtime = {
      ...this.db.data.runtime,
      activeProcess: process,
      queue,
      stopRequested: false,
      currentFileId: queue[0]?.id ?? null,
      currentFileName: queue[0]?.name ?? null,
      lastError: null,
    };
    void this.db.write();
  }

  setCurrent(fileId: string | null, fileName: string | null): void {
    if (!this.db.data) {
      return;
    }
    this.db.data.runtime.currentFileId = fileId;
    this.db.data.runtime.currentFileName = fileName;
    void this.db.write();
  }

  shiftQueue(processedId: string): void {
    if (!this.db.data) {
      return;
    }
    this.db.data.runtime.queue = this.db.data.runtime.queue.filter((item) => item.id !== processedId);
    this.db.data.runtime.currentFileId = this.db.data.runtime.queue[0]?.id ?? null;
    this.db.data.runtime.currentFileName = this.db.data.runtime.queue[0]?.name ?? null;
    void this.db.write();
  }

  requestStop(): void {
    if (!this.db.data) {
      return;
    }
    this.db.data.runtime.stopRequested = true;
    this.db.data.runtime.queue = [];
    void this.db.write();
  }

  isStopRequested(): boolean {
    return this.getRuntime().stopRequested;
  }

  finishProcess(): void {
    if (!this.db.data) {
      return;
    }
    this.db.data.runtime.activeProcess = 'idle';
    this.db.data.runtime.currentFileId = null;
    this.db.data.runtime.currentFileName = null;
    this.db.data.runtime.queue = [];
    this.db.data.runtime.stopRequested = false;
    void this.db.write();
  }

  setLastProcessed(name: string): void {
    if (!this.db.data) {
      return;
    }
    this.db.data.runtime.lastProcessedName = name;
    this.db.data.runtime.lastProcessedAt = new Date().toISOString();
    void this.db.write();
  }

  setLastError(message: string | null): void {
    if (!this.db.data) {
      return;
    }
    this.db.data.runtime.lastError = message;
    void this.db.write();
  }

  private normalizeRuntime(input: Partial<RuntimeState> | undefined): RuntimeState {
    const raw = input ?? {};
    const activeProcess = raw.activeProcess === 'ingest' || raw.activeProcess === 'publish' ? raw.activeProcess : 'idle';
    const queue = Array.isArray(raw.queue)
      ? raw.queue.filter(
          (item): item is { id: string; name: string } =>
            Boolean(item && typeof item.id === 'string' && typeof item.name === 'string'),
        )
      : [];

    const runtime: RuntimeState = {
      activeProcess,
      currentFileId: typeof raw.currentFileId === 'string' ? raw.currentFileId : null,
      currentFileName: typeof raw.currentFileName === 'string' ? raw.currentFileName : null,
      queue,
      stopRequested: false,
      lastProcessedAt: typeof raw.lastProcessedAt === 'string' ? raw.lastProcessedAt : null,
      lastProcessedName: typeof raw.lastProcessedName === 'string' ? raw.lastProcessedName : null,
      lastError: typeof raw.lastError === 'string' ? raw.lastError : null,
    };

    if (runtime.activeProcess === 'idle' || runtime.queue.length === 0) {
      runtime.currentFileId = null;
      runtime.currentFileName = null;
    }

    return runtime;
  }
}
