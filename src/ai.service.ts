import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { readFileSync, createReadStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private readonly client: OpenAI;
  private readonly systemPrompt: string;

  constructor(config: ConfigService) {
    const apiKey = config.get<string>('OPENAI_API_KEY');
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY is required');
    }
    this.client = new OpenAI({ apiKey });
    const promptPath = config.get<string>('SYSTEM_PROMPT_PATH') ?? 'system-prompt.md';
    this.systemPrompt = readFileSync(promptPath, 'utf8');
  }

  async transcribeVideo(videoPath: string): Promise<string> {
    const tempDir = await mkdtemp(join(tmpdir(), 'apb-transcribe-'));
    const audioPath = join(tempDir, 'audio-for-transcription.mp3');

    try {
      await this.extractSpeechAudio(videoPath, audioPath);
      const audioStats = await stat(audioPath);
      const sizeMb = audioStats.size / 1024 / 1024;
      const sizeLabel = sizeMb >= 1 ? `${sizeMb.toFixed(2)} MB` : `${(audioStats.size / 1024).toFixed(1)} KB`;
      this.logger.log(`Prepared audio for transcription: ${sizeLabel}`);

      const transcript = await this.client.audio.transcriptions.create({
        file: createReadStream(audioPath),
        model: 'whisper-1',
        response_format: 'text',
        language: 'ru',
      });
      return transcript;
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async generateDescription(script: string, videoName: string): Promise<string> {
    const result = await this.client.chat.completions.create({
      model: 'gpt-4.1',
      messages: [
        { role: 'system', content: this.systemPrompt },
        { role: 'user', content: `Название видео: ${videoName}\n\nСценарий/транскрипт:\n${script}` },
      ],
      temperature: 0.6,
      max_tokens: 400,
    });

    const content = result.choices[0]?.message?.content;
    if (!content) {
      this.logger.error('OpenAI response was empty');
      throw new Error('Не удалось сгенерировать описание');
    }
    return content.trim();
  }

  private async extractSpeechAudio(videoPath: string, audioPath: string): Promise<void> {
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
      const ffmpeg = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
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
  }
}
