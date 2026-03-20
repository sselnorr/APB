import { normalizeVideoDescription } from './text';

describe('text utils', () => {
  it('moves hashtags to the final line and preserves CTA above them', () => {
    const result = normalizeVideoDescription(
      [
        'С 1 июля 2026 года биржи без лицензии ЕС должны закрыться.',
        '',
        '#криптовалюта #биткоин #крипторынок #инвестиции #альткоины',
        '',
        'Переходи в моё крипто-комьюнити по ссылке в профиле.',
      ].join('\n'),
    );

    expect(result).toBe(
      [
        'С 1 июля 2026 года биржи без лицензии ЕС должны закрыться.',
        'Переходи в моё крипто-комьюнити по ссылке в профиле.',
        '',
        '#криптовалюта #биткоин #крипторынок #инвестиции #альткоины',
      ].join('\n'),
    );
  });
});
