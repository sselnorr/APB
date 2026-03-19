import { isPublishWindowNow, nextPublishSlot, publishSlotKey } from './time';

describe('time utils', () => {
  const config = {
    timezone: 'Europe/Berlin',
    windows: ['08:01', '11:01', '14:01', '17:31', '20:01'],
  };

  it('calculates next publish slot in order', () => {
    const next = nextPublishSlot(new Date('2026-03-18T10:42:00.000Z'), config);
    expect(publishSlotKey(next, config.timezone)).toBe('2026-03-18T14:01');
  });

  it('detects matching publish minute', () => {
    expect(isPublishWindowNow(new Date('2026-03-18T08:01:10.000Z'), { ...config, timezone: 'UTC' })).toBe(true);
    expect(isPublishWindowNow(new Date('2026-03-18T08:02:10.000Z'), { ...config, timezone: 'UTC' })).toBe(false);
  });
});
