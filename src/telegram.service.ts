import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Markup, Telegraf } from 'telegraf';

export type CallbackHandlers = {
  onStart: (chatId: number) => Promise<void>;
  onIngest: (chatId: number) => Promise<void>;
  onPublishAll: (chatId: number, query?: string) => Promise<void>;
  onStop: (chatId: number) => Promise<void>;
  onPublishSingle: (chatId: number, resultVideoFileId: string) => Promise<void>;
};

@Injectable()
export class TelegramBotService {
  private readonly logger = new Logger(TelegramBotService.name);
  private readonly token?: string;
  private readonly targetChatId?: number;
  private bot?: Telegraf;
  private handlers?: CallbackHandlers;
  private polling = false;
  private pollingAbort = false;
  private updateOffset = 0;

  constructor(private readonly config: ConfigService) {
    this.token = this.config.get<string>('TELEGRAM_BOT_TOKEN')?.trim();
    this.targetChatId = this.parseChatId(this.config.get<string>('TELEGRAM_TARGET_CHAT_ID'));
  }

  setHandlers(handlers: CallbackHandlers): void {
    this.handlers = handlers;
  }

  async start(): Promise<void> {
    if (!this.token || !this.targetChatId) {
      this.logger.warn('Telegram bot disabled: TELEGRAM_BOT_TOKEN or TELEGRAM_TARGET_CHAT_ID missing');
      return;
    }

    this.bot = new Telegraf(this.token);
    try {
      await this.bot.telegram.deleteWebhook({ drop_pending_updates: false });
    } catch (err) {
      this.logger.warn(`Cannot delete webhook before polling start: ${err}`);
    }
    this.startPollingLoop();

    process.once('SIGINT', () => this.stopPolling());
    process.once('SIGTERM', () => this.stopPolling());
  }

  async sendInfo(chatId: number, text: string): Promise<number | undefined> {
    if (!this.bot) {
      return undefined;
    }
    const res = await this.bot.telegram.sendMessage(chatId, this.escape(text), {
      parse_mode: 'HTML',
    });
    return res.message_id;
  }

  async sendPublishButton(chatId: number, resultVideoFileId: string, title: string): Promise<number | undefined> {
    if (!this.bot) {
      return undefined;
    }

    const html = `✅ ${this.escape(title)}\nГотово к публикации.`;
    const res = await this.bot.telegram.sendMessage(chatId, html, {
      parse_mode: 'HTML',
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback('Publish', `publish_one:${resultVideoFileId}`)],
      ]).reply_markup,
    });

    return res.message_id;
  }

  private escape(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  private parseChatId(value: string | undefined): number | undefined {
    if (!value) {
      return undefined;
    }
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  private startPollingLoop(): void {
    if (!this.bot || this.polling) {
      return;
    }
    this.polling = true;
    this.pollingAbort = false;
    void this.pollUpdates();
  }

  private stopPolling(): void {
    this.pollingAbort = true;
    this.polling = false;
  }

  private async pollUpdates(): Promise<void> {
    if (!this.bot) {
      this.polling = false;
      return;
    }

    while (!this.pollingAbort) {
      try {
        const updates = (await this.bot.telegram.callApi('getUpdates', {
          offset: this.updateOffset,
          timeout: 15,
          allowed_updates: ['message', 'callback_query'],
        })) as Array<any>;

        for (const update of updates) {
          this.updateOffset = Math.max(this.updateOffset, (update.update_id as number) + 1);
          await this.handleRawUpdate(update);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes('409')) {
          this.logger.warn(`Telegram polling conflict (409). Another getUpdates session is active.`);
        } else {
          this.logger.error(`Telegram polling error: ${message}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }

    this.polling = false;
  }

  private async handleRawUpdate(update: any): Promise<void> {
    if (!this.handlers) {
      return;
    }

    const message = update.message;
    if (message?.chat?.id === this.targetChatId && typeof message.text === 'string') {
      const text = message.text.trim();
      if (text === '/start') {
        await this.handlers.onStart(message.chat.id);
        return;
      }
      if (text === '/ingest') {
        await this.handlers.onIngest(message.chat.id);
        return;
      }
      if (text === '/publish' || text.startsWith('/publish ')) {
        const query = text.replace(/^\/publish\s*/i, '').trim();
        await this.handlers.onPublishAll(message.chat.id, query || undefined);
        return;
      }
      if (text === '/stop') {
        await this.handlers.onStop(message.chat.id);
        return;
      }
      return;
    }

    const callbackQuery = update.callback_query;
    if (callbackQuery?.message?.chat?.id !== this.targetChatId) {
      return;
    }

    const data = callbackQuery?.data;
    if (!data) {
      return;
    }

    const [action, fileId] = String(data).split(':');
    if (action === 'publish_one' && fileId) {
      await this.handlers.onPublishSingle(callbackQuery.message.chat.id, fileId);
    }

    if (callbackQuery.id) {
      await this.bot?.telegram.answerCbQuery(callbackQuery.id).catch(() => undefined);
    }
  }
}
