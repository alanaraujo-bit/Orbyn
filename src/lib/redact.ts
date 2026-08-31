/**
 * Secret redaction for logs and audit records.
 *
 * Two layers: key-name matching (tokens, cookies, secrets) and value-shape
 * matching (long opaque strings that look like credentials).
 */

const SENSITIVE_KEY_PATTERN =
  /(secret|token|password|passwd|api[-_]?key|apikey|authorization|auth|cookie|session|credential|private[-_]?key|signature|bearer)/i;

const VALUE_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g, // OpenAI style keys
  /\bEAA[A-Za-z0-9]{20,}\b/g, // Meta access tokens
  /\bBearer\s+[A-Za-z0-9._-]{16,}\b/gi,
];

export const REDACTED = '[REDACTED]';

export function redactString(value: string): string {
  let out = value;
  for (const pattern of VALUE_PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }
  return out;
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[TRUNCATED]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message) };
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : redact(entry, depth + 1);
    }
    return out;
  }
  return '[UNSERIALIZABLE]';
}
