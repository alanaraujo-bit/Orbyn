import { NextResponse } from 'next/server';
import { PANEL_COOKIE, safeEqual, sessionToken } from '@/lib/panel-auth';

/** Thirty days: long enough to be usable from a phone, short enough to expire. */
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

/**
 * Redirects here are relative on purpose.
 *
 * Behind `pnpm tunnel` the browser is at a public HTTPS hostname while this
 * route sees `http://localhost:4310/...`. An absolute redirect built from
 * `request.url` therefore sends the phone to localhost, and from an HTTPS page
 * the browser upgrades that to https and fails with ERR_SSL_PROTOCOL_ERROR —
 * the operator types the right password and lands on an error page, already
 * signed in. A relative Location is resolved against the address the browser
 * actually used, which is right in both cases.
 */
function redirect(location: string): NextResponse {
  return new NextResponse(null, { status: 303, headers: { location } });
}

/**
 * Whether the browser's own connection is HTTPS.
 *
 * The tunnel terminates TLS and forwards plaintext, so the local protocol says
 * nothing about what the phone used. `x-forwarded-proto` is what the tunnel
 * sets, and it is the only thing that can tell us to mark the cookie Secure.
 */
function isSecureRequest(request: Request): boolean {
  const forwarded = request.headers.get('x-forwarded-proto');
  if (forwarded) return forwarded.split(',')[0]?.trim() === 'https';
  return new URL(request.url).protocol === 'https:';
}

export async function POST(request: Request): Promise<Response> {
  const form = await request.formData();
  const submitted = String(form.get('senha') ?? '');
  const destination = String(form.get('destino') ?? '/') || '/';
  const password = process.env.PANEL_PASSWORD?.trim();

  if (!password) {
    return redirect('/entrar?erro=sem_senha');
  }

  if (!safeEqual(submitted, password)) {
    return redirect('/entrar?erro=invalida');
  }

  // Only ever redirect somewhere inside this panel: a destination taken from the
  // query string is attacker-controlled, and an open redirect on a login page is
  // how a convincing phishing link gets built.
  const safeDestination = destination.startsWith('/') && !destination.startsWith('//') ? destination : '/';

  const response = redirect(safeDestination);
  response.cookies.set(PANEL_COOKIE, await sessionToken(password), {
    httpOnly: true,
    sameSite: 'lax',
    secure: isSecureRequest(request),
    path: '/',
    maxAge: MAX_AGE_SECONDS,
  });
  return response;
}
