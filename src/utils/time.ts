const SLOT_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

export interface PublishWindowConfig {
  timezone: string;
  windows: string[];
}

export function parsePublishWindows(raw: string | undefined): string[] {
  const fallback = ['08:01', '11:01', '14:01', '17:31', '20:01'];
  const windows = (raw ?? fallback.join(','))
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  for (const window of windows) {
    if (!SLOT_PATTERN.test(window)) {
      throw new Error(`Invalid publish window: ${window}`);
    }
  }

  return Array.from(new Set(windows)).sort();
}

function zonedParts(date: Date, timezone: string): { year: number; month: number; day: number; hour: number; minute: number } {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  const parts = formatter.formatToParts(date);
  const read = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value ?? '0');

  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
  };
}

function timezoneOffsetMs(date: Date, timezone: string): number {
  const zoned = zonedParts(date, timezone);
  const asUtc = Date.UTC(zoned.year, zoned.month - 1, zoned.day, zoned.hour, zoned.minute);
  return asUtc - date.getTime();
}

function makeDateInTimezone(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timezone: string,
): Date {
  const probe = new Date(Date.UTC(year, month - 1, day, hour, minute));
  const offset = timezoneOffsetMs(probe, timezone);
  return new Date(Date.UTC(year, month - 1, day, hour, minute) - offset);
}

function slotDatesForDay(date: Date, config: PublishWindowConfig): Date[] {
  const zoned = zonedParts(date, config.timezone);
  return config.windows.map((slot) => {
    const match = slot.match(SLOT_PATTERN);
    if (!match) {
      throw new Error(`Invalid publish slot format: ${slot}`);
    }
    return makeDateInTimezone(zoned.year, zoned.month, zoned.day, Number(match[1]), Number(match[2]), config.timezone);
  });
}

export function nextPublishSlot(after: Date, config: PublishWindowConfig): Date {
  const todaySlots = slotDatesForDay(after, config);
  const nextToday = todaySlots.find((slot) => slot.getTime() > after.getTime());
  if (nextToday) {
    return nextToday;
  }

  const zoned = zonedParts(after, config.timezone);
  const tomorrowProbe = makeDateInTimezone(zoned.year, zoned.month, zoned.day + 1, 0, 0, config.timezone);
  return slotDatesForDay(tomorrowProbe, config)[0];
}

export function isPublishWindowNow(now: Date, config: PublishWindowConfig): boolean {
  const zoned = zonedParts(now, config.timezone);
  const key = `${String(zoned.hour).padStart(2, '0')}:${String(zoned.minute).padStart(2, '0')}`;
  return config.windows.includes(key);
}

export function publishSlotKey(date: Date, timezone: string): string {
  const zoned = zonedParts(date, timezone);
  return `${zoned.year}-${String(zoned.month).padStart(2, '0')}-${String(zoned.day).padStart(2, '0')}T${String(zoned.hour).padStart(2, '0')}:${String(zoned.minute).padStart(2, '0')}`;
}
