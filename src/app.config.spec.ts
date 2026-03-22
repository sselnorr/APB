import { ConfigService } from '@nestjs/config';
import { AppConfigService } from './app.config';

describe('AppConfigService feature flags', () => {
  it('filters video and social platforms by on/off flags', () => {
    const config = new AppConfigService(
      new ConfigService({
        UPLOAD_POST_PLATFORMS: 'youtube,instagram,tiktok',
        UPLOAD_POST_SOCIAL_PLATFORMS: 'x,threads,facebook',
        YOUTUBE: 'on',
        REELS: 'off',
        TIKTOK: 'on',
        X: 'on',
        THREADS: 'off',
        FACEBOOK: 'on',
      }),
    );

    expect(config.uploadPlatforms).toEqual(['youtube', 'tiktok']);
    expect(config.uploadSocialPlatforms).toEqual(['x', 'facebook']);
  });

  it('parses article cluster flag and extended source types', () => {
    const config = new AppConfigService(
      new ConfigService({
        ARTICLE_CLUSTER: 'off',
        ARTICLE_SOURCES_JSON: JSON.stringify([
          { name: 'TG', url: 'https://t.me/s/example', type: 'telegram' },
          { name: 'X', url: 'https://example.com/feed.xml', type: 'x' },
        ]),
      }),
    );

    expect(config.articleClusterEnabled).toBe(false);
    expect(config.articleSources).toEqual([
      { name: 'TG', url: 'https://t.me/s/example', type: 'telegram' },
      { name: 'X', url: 'https://example.com/feed.xml', type: 'x' },
    ]);
  });
});
