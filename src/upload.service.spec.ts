import { UploadService } from './upload.service';

describe('UploadService', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('sends full caption to TikTok and Instagram while keeping hashtags at the end', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          results: {
            tiktok: { success: true },
            instagram: { success: true },
            youtube: { success: true },
          },
        }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const service = new UploadService({
      uploadPostApiKey: 'key',
      uploadPostUsername: 'video_profile',
      uploadPlatforms: ['tiktok', 'instagram', 'youtube'],
      postVideoFirstCommentEnabled: true,
      uploadVideoFirstComment:
        'Друзья, спасибо что смотрите мой контент! Проявите активность на моих видео, тем самым вы поддержите мои старания 🤗 ',
    } as any);

    await service.publish({
      videoUrl: 'https://cdn.example.com/video.mp4',
      title: 'MiCA дедлайн',
      description: [
        'Разбор дедлайна MiCA и возможных ограничений для бирж.',
        '',
        '#криптовалюта #биткоин #крипторынок #инвестиции #альткоины',
        '',
        'Переходи в моё крипто-комьюнити по ссылке в профиле.',
      ].join('\n'),
    });

    const [, init] = fetchMock.mock.calls[0] as [string, { body: FormData }];
    const formEntries = Array.from(init.body.entries()) as Array<[string, FormDataEntryValue]>;
    const lookup = new Map<string, string[]>();
    for (const [key, value] of formEntries) {
      const next = lookup.get(key) ?? [];
      next.push(typeof value === 'string' ? value : String(value));
      lookup.set(key, next);
    }

    const expectedCaption = [
      'Разбор дедлайна MiCA и возможных ограничений для бирж.',
      'Переходи в моё крипто-комьюнити по ссылке в профиле.',
      '',
      '#криптовалюта #биткоин #крипторынок #инвестиции #альткоины',
    ].join('\n');

    expect(lookup.get('tiktok_title')).toEqual([expectedCaption]);
    expect(lookup.get('instagram_title')).toEqual([expectedCaption]);
    expect(lookup.get('youtube_description')).toEqual([expectedCaption]);
    expect(lookup.get('instagram_first_comment')).toEqual([
      'Друзья, спасибо что смотрите мой контент! Проявите активность на моих видео, тем самым вы поддержите мои старания 🤗 ',
    ]);
    expect(lookup.get('youtube_first_comment')).toEqual([
      'Друзья, спасибо что смотрите мой контент! Проявите активность на моих видео, тем самым вы поддержите мои старания 🤗 ',
    ]);
  });
});
