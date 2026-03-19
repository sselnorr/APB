import { Injectable, Logger } from '@nestjs/common';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { AppConfigService } from './app.config';

@Injectable()
export class MediaProcessingService {
  private readonly logger = new Logger(MediaProcessingService.name);

  constructor(private readonly appConfig: AppConfigService) {}

  async assertFfmpegAvailable(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(this.appConfig.ffmpegPath, ['-version'], { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });
      child.on('error', (error) => reject(error));
      child.on('close', (code) => {
        if (code === 0) {
          resolve();
          return;
        }
        reject(new Error(`ffmpeg exited with code ${code}: ${stderr}`));
      });
    });
  }

  async extractSpeechAudio(videoPath: string): Promise<{ audioPath: string; cleanup: () => Promise<void>; sizeBytes: number }> {
    const tempDir = await mkdtemp(join(tmpdir(), 'apb-ffmpeg-'));
    const audioPath = join(tempDir, 'speech.mp3');
    const args = [
      '-y',
      '-i',
      videoPath,
      '-vn',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-b:a',
      '24k',
      '-codec:a',
      'libmp3lame',
      audioPath,
    ];

    await new Promise<void>((resolve, reject) => {
      const ffmpeg = spawn(this.appConfig.ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';

      ffmpeg.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });
      ffmpeg.on('error', (error) => reject(error));
      ffmpeg.on('close', (code) => {
        if (code === 0) {
          resolve();
          return;
        }
        reject(new Error(`ffmpeg exited with code ${code}: ${stderr}`));
      });
    });

    const audioStat = await stat(audioPath);
    this.logger.log(`Prepared audio for transcription: ${(audioStat.size / 1024 / 1024).toFixed(2)}MB`);

    return {
      audioPath,
      sizeBytes: audioStat.size,
      cleanup: async () => {
        await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
      },
    };
  }
}
