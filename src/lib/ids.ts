import { randomUUID, createHash } from 'node:crypto';

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Stable key used to guarantee at-most-once execution of a side effect. */
export function idempotencyKey(...parts: readonly (string | number)[]): string {
  return sha256(parts.map(String).join('|'));
}
