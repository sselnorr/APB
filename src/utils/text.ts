import { createHash } from 'node:crypto';

export function normalizePrompt(value: string | undefined, fallback: string): string {
  if (!value?.trim()) {
    return fallback;
  }
  return value.replace(/\\n/g, '\n').trim();
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 80);
}

export function stripExtension(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, '');
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function truncate(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max)}...`;
}

export function normalizeVideoDescription(value: string): string {
  const normalized = value.replace(/\r\n/g, '\n').trim();
  if (!normalized) {
    return normalized;
  }

  const lines = normalized
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const hashtags: string[] = [];
  const textLines: string[] = [];
  for (const line of lines) {
    const matches = line.match(/#[\p{L}\p{N}_]+/gu) ?? [];
    for (const tag of matches) {
      if (!hashtags.includes(tag)) {
        hashtags.push(tag);
      }
    }

    const cleaned = line
      .replace(/#[\p{L}\p{N}_]+/gu, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();

    if (cleaned) {
      textLines.push(cleaned);
    }
  }

  if (!hashtags.length) {
    return textLines.join('\n');
  }

  return `${textLines.join('\n')}\n\n${hashtags.join(' ')}`.trim();
}
