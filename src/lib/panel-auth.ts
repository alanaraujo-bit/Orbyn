/**
 * Authentication for the operator panel.
 *
 * The panel was written for loopback, but `pnpm tunnel` forwards *every* path to
 * it — not only `/api/webhooks/instagram`. So while a tunnel is up, the whole
 * panel answers on the public URL: lead data, message contents, and the actions
 * that schedule a real DM. This module is the gate that closes that.
 *
 * The session cookie carries an HMAC of the password rather than the password
 * itself, so a stolen cookie never reveals the secret, and a cookie cannot be
 * forged without knowing it. Web Crypto is used because the proxy runs before
 * the Node request pipeline.
 */

export const PANEL_COOKIE = 'orbyn_panel';

const TOKEN_MESSAGE = 'orbyn-panel-session-v1';

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/** Derives the cookie value for a password. Same input, same token. */
export async function sessionToken(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return toHex(await crypto.subtle.sign('HMAC', key, encoder.encode(TOKEN_MESSAGE)));
}

/** Compares in constant time, so a wrong guess leaks nothing through timing. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
