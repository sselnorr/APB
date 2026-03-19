import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { AppConfigService } from './app.config';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);
  private connected = false;

  constructor(private readonly appConfig: AppConfigService) {
    super({
      datasources: appConfig.databaseUrl
        ? {
            db: {
              url: appConfig.databaseUrl,
            },
          }
        : undefined,
      log: ['warn', 'error'],
    });
  }

  async connectIfConfigured(): Promise<boolean> {
    if (this.connected) {
      return true;
    }
    if (!this.appConfig.databaseUrl) {
      this.logger.warn('DATABASE_URL is missing; database-backed flows are disabled');
      return false;
    }
    await this.$connect();
    this.connected = true;
    return true;
  }

  async onModuleDestroy(): Promise<void> {
    if (this.connected) {
      await this.$disconnect();
    }
  }
}
