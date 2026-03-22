import { SocialPublisherService } from './social-publisher.service';

describe('SocialPublisherService', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('uses text endpoint when image generation is disabled and no image file exists', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          results: {
            x: { success: true },
            threads: { success: true },
            facebook: { success: false, error: 'page not connected' },
          },
        }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const service = new SocialPublisherService(
      {
        uploadPostApiKey: 'key',
        uploadSocialProfile: 'crypto_text',
        uploadSocialPlatforms: ['x', 'threads', 'facebook'],
      } as any,
      {
        downloadFile: jest.fn(),
      } as any,
    );

    const result = await service.publish({
      title: 'Quick market note',
      body: 'BTC держится выше диапазона, а рынок ждёт новые макроданные.',
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.upload-post.com/api/upload_text');
    expect(result.status).toBe('partial');
  });
});
