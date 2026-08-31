import { AppError } from '@/lib/errors';

const HANDLE_PATTERN = /^[a-z0-9._]{1,30}$/;

/**
 * Canonical form of an Instagram handle: lowercase, no `@`, no URL wrapper.
 * Every lookup, dedupe check and suppression check uses this form.
 */
export function normalizeHandle(input: string): string {
  let value = input.trim();
  if (value.length === 0) {
    throw new AppError('validation_failed', 'Informe um @ do Instagram.');
  }
  const urlMatch = /^(?:https?:\/\/)?(?:www\.)?instagram\.com\/([^/?#]+)/i.exec(value);
  if (urlMatch?.[1]) value = urlMatch[1];
  value = value.replace(/^@+/, '').replace(/\/+$/, '').toLowerCase();
  if (!HANDLE_PATTERN.test(value)) {
    throw new AppError('validation_failed', `"${input}" não é um @ do Instagram válido.`, { details: { input } });
  }
  return value;
}

export function isValidHandle(input: string): boolean {
  try {
    normalizeHandle(input);
    return true;
  } catch {
    return false;
  }
}

export function displayHandle(normalized: string): string {
  return `@${normalized}`;
}

export function profileUrl(normalized: string): string {
  return `https://www.instagram.com/${normalized}/`;
}
