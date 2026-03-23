import { ConfigService } from '@nestjs/config';
import { AppConfigService } from './app.config';

describe('AppConfigService', () => {
  it('treats Telegram URLs marked as rss as telegram article sources', () => {
    const config = new AppConfigService(
      new ConfigService({
        ARTICLE_SOURCES_JSON: JSON.stringify([
          {
            name: 'trade_by_booba',
            url: 'https://t.me/trade_by_booba',
            type: 'rss',
          },
        ]),
      }),
    );

    expect(config.articleSources).toEqual([
      {
        name: 'trade_by_booba',
        url: 'https://t.me/trade_by_booba',
        type: 'telegram',
      },
    ]);
  });
});
