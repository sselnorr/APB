import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { join } from 'node:path';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { GoogleDriveService } from './google-drive.service';
import { AiService } from './ai.service';
import { StateService } from './state.service';
import { TelegramBotService } from './telegram.service';
import { UploadService } from './upload.service';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: join(process.cwd(), '.env'),
    }),
  ],
  controllers: [AppController],
  providers: [AppService, GoogleDriveService, AiService, StateService, TelegramBotService, UploadService],
})
export class AppModule {}
