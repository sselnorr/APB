import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppModule } from './app.module';

const LOCK_PATH = join(process.cwd(), 'data', 'app.lock');

function acquireProcessLock(logger: Logger): void {
  const dataDir = join(process.cwd(), 'data');
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

  if (existsSync(LOCK_PATH)) {
    const pidRaw = readFileSync(LOCK_PATH, 'utf8').trim();
    const pid = Number(pidRaw);
    if (Number.isFinite(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        logger.error(`Another app instance is already running (pid=${pid}). Exit.`);
        process.exit(1);
      } catch {
        // stale lock, continue
      }
    }
  }

  writeFileSync(LOCK_PATH, String(process.pid), 'utf8');
  const release = () => {
    try {
      if (existsSync(LOCK_PATH)) {
        unlinkSync(LOCK_PATH);
      }
    } catch {
      // ignore
    }
  };
  process.once('exit', release);
  process.once('SIGINT', () => {
    release();
    process.exit(0);
  });
  process.once('SIGTERM', () => {
    release();
    process.exit(0);
  });
}

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  acquireProcessLock(logger);
  const app = await NestFactory.create(AppModule);
  const configService = app.get(ConfigService);
  const port = Number(configService.get<string>('PORT'));
  await app.init();
  try {
    await app.listen(port);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('EADDRINUSE')) {
      logger.error(`Port ${port} is busy; HTTP server disabled, bot/scheduler continue running.`);
      return;
    }
    throw err;
  }
}
bootstrap();
