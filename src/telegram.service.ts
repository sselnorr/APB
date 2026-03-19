import { Injectable, Logger } from '@nestjs/common';
import { Markup, Telegraf } from 'telegraf';
import { AppConfigService } from './app.config';

export interface OwnerEditMessage {
  chatId: number;
  messageId?: number;
  text?: string;
  photo?: {
    fileId: string;
    mimeType: string;
  };
}

export type TelegramHandlers = {
  onStart: (chatId: number) => Promise<void>;
  onDraftPublish: (draftId: string) => Promise<void>;
  onDraftEdit: (draftId: string) => Promise<void>;
  onDraftDelete: (draftId: string) => Promise<void>;
  onDraftDeleteConfirm: (draftId: string) => Promise<void>;
  onDraftDeleteCancel: (draftId: string) => Promise<void>;
  onDraftRewrite: (draftId: string) => Promise<void>;
  onEditClose: (draftId: string) => Promise<void>;
  onOwnerEditInput: (payload: OwnerEditMessage) => Promise<void>;
};

@Injectable()
export class TelegramBotService {
  private readonly logger = new Logger(TelegramBotService.name);
  private bot?: Telegraf;
  private handlers?: TelegramHandlers;
  private polling = false;
  private pollingAbort = false;
  private updateOffset = 0;

  constructor(private readonly appConfig: AppConfigService) {}

  setHandlers(handlers: TelegramHandlers): void {
    this.handlers = handlers;
  }

  isEnabled(): boolean {
    return Boolean(this.appConfig.telegramBotToken && this.appConfig.telegramOwnerChatId);
  }

  async start(): Promise<void> {
    if (!this.isEnabled()) {
      this.logger.warn('Telegram bot disabled: TELEGRAM_BOT_TOKEN or TELEGRAM_OWNER_CHAT_ID missing');
      return;
    }

    this.bot = new Telegraf(this.appConfig.telegramBotToken as string);
    try {
      await this.bot.telegram.deleteWebhook({ drop_pending_updates: false });
    } catch (error) {
      this.logger.warn(`Cannot delete webhook before polling start: ${error}`);
    }
    this.startPollingLoop();
    process.once('SIGINT', () => this.stopPolling());
    process.once('SIGTERM', () => this.stopPolling());
  }

  async sendInfo(chatId: number, text: string): Promise<number | undefined> {
    if (!this.bot) {
      return undefined;
    }
    const response = await this.bot.telegram.sendMessage(chatId, this.escape(text), {
      parse_mode: 'HTML',
    });
    return response.message_id;
  }

  async sendDraftPreview(params: {
    chatId: number;
    draftId: string;
    title: string;
    body: string;
    imageUrl?: string;
  }): Promise<number | undefined> {
    if (!this.bot) {
      return undefined;
    }

    const caption = `<b>${this.escape(params.title)}</b>\n\n${this.escape(params.body)}`;
    const replyMarkup = this.draftKeyboard(params.draftId);
    if (params.imageUrl) {
      const response = await this.bot.telegram.sendPhoto(params.chatId, params.imageUrl, {
        caption,
        parse_mode: 'HTML',
        reply_markup: replyMarkup,
      });
      return response.message_id;
    }

    const response = await this.bot.telegram.sendMessage(params.chatId, caption, {
      parse_mode: 'HTML',
      reply_markup: replyMarkup,
    });
    return response.message_id;
  }

  async sendEditPrompt(chatId: number, draftId: string): Promise<number | undefined> {
    if (!this.bot) {
      return undefined;
    }

    const response = await this.bot.telegram.sendMessage(
      chatId,
      this.escape('Режим редактирования активирован. Отправьте новый текст, фото или текст + фото.'),
      {
        parse_mode: 'HTML',
        reply_markup: Markup.inlineKeyboard([[Markup.button.callback('Закрыть', `tg_edit_close:${draftId}`)]])
          .reply_markup,
      },
    );
    return response.message_id;
  }

  async sendDeleteConfirmation(chatId: number, draftId: string): Promise<number | undefined> {
    if (!this.bot) {
      return undefined;
    }
    const response = await this.bot.telegram.sendMessage(
      chatId,
      this.escape('Подтвердите удаление черновика.'),
      {
        parse_mode: 'HTML',
        reply_markup: Markup.inlineKeyboard([
          [
            Markup.button.callback('Confirm delete', `tg_delete_confirm:${draftId}`),
            Markup.button.callback('Cancel', `tg_delete_cancel:${draftId}`),
          ],
        ]).reply_markup,
      },
    );
    return response.message_id;
  }

  async deleteMessage(chatId: number, messageId: number): Promise<void> {
    await this.bot?.telegram.deleteMessage(chatId, messageId).catch(() => undefined);
  }

  async sendChannelPost(channelId: string, body: string, imageUrl?: string): Promise<number | undefined> {
    if (!this.bot) {
      return undefined;
    }

    if (imageUrl) {
      const response = await this.bot.telegram.sendPhoto(channelId, imageUrl, {
        caption: this.escape(body),
        parse_mode: 'HTML',
      });
      return response.message_id;
    }

    const response = await this.bot.telegram.sendMessage(channelId, this.escape(body), {
      parse_mode: 'HTML',
    });
    return response.message_id;
  }

  async downloadTelegramPhoto(fileId: string): Promise<{ bytes: Buffer; mimeType: string }> {
    if (!this.bot) {
      throw new Error('Telegram bot is not started');
    }

    const file = await this.bot.telegram.getFile(fileId);
    if (!file.file_path) {
      throw new Error('Telegram file path is missing');
    }

    const url = `https://api.telegram.org/file/bot${this.appConfig.telegramBotToken}/${file.file_path}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Cannot download Telegram file: ${response.status}`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    const mimeType = response.headers.get('content-type') ?? 'image/jpeg';
    return { bytes, mimeType };
  }

  private escape(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  private draftKeyboard(draftId: string) {
    return Markup.inlineKeyboard([
      [
        Markup.button.callback('Publish', `tg_publish:${draftId}`),
        Markup.button.callback('Edit', `tg_edit:${draftId}`),
      ],
      [
        Markup.button.callback('Delete', `tg_delete:${draftId}`),
        Markup.button.callback('Rewrite', `tg_rewrite:${draftId}`),
      ],
    ]).reply_markup;
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
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes('409')) {
          this.logger.warn('Telegram polling conflict (409). Another session is active.');
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

    const ownerChatId = this.appConfig.telegramOwnerChatId;
    const message = update.message;
    if (message?.chat?.id === ownerChatId) {
      if (typeof message.text === 'string' && message.text.trim() === '/start') {
        await this.handlers.onStart(message.chat.id);
        return;
      }

      if (typeof message.text === 'string' || Array.isArray(message.photo)) {
        const photo = Array.isArray(message.photo) && message.photo.length
          ? message.photo[message.photo.length - 1]
          : undefined;
        await this.handlers.onOwnerEditInput({
          chatId: message.chat.id,
          messageId: typeof message.message_id === 'number' ? message.message_id : undefined,
          text: typeof message.caption === 'string' && message.caption.trim()
            ? message.caption.trim()
            : typeof message.text === 'string' && message.text.trim()
              ? message.text.trim()
              : undefined,
          photo: photo
            ? {
                fileId: photo.file_id,
                mimeType: 'image/jpeg',
              }
            : undefined,
        });
        return;
      }
    }

    const callbackQuery = update.callback_query;
    if (callbackQuery?.message?.chat?.id !== ownerChatId) {
      return;
    }

    const data = typeof callbackQuery?.data === 'string' ? callbackQuery.data : '';
    const [action, draftId] = data.split(':');
    if (!draftId) {
      return;
    }

    switch (action) {
      case 'tg_publish':
        await this.handlers.onDraftPublish(draftId);
        break;
      case 'tg_edit':
        await this.handlers.onDraftEdit(draftId);
        break;
      case 'tg_delete':
        await this.handlers.onDraftDelete(draftId);
        break;
      case 'tg_delete_confirm':
        await this.handlers.onDraftDeleteConfirm(draftId);
        break;
      case 'tg_delete_cancel':
        await this.handlers.onDraftDeleteCancel(draftId);
        break;
      case 'tg_rewrite':
        await this.handlers.onDraftRewrite(draftId);
        break;
      case 'tg_edit_close':
        await this.handlers.onEditClose(draftId);
        break;
      default:
        break;
    }

    if (callbackQuery.id) {
      await this.bot?.telegram.answerCbQuery(callbackQuery.id).catch(() => undefined);
    }
  }
}
