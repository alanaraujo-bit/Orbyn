import { NextResponse, type NextRequest } from 'next/server';
import { PANEL_COOKIE, safeEqual, sessionToken } from '@/lib/panel-auth';

/**
 * Gate for the operator panel.
 *
 * `pnpm tunnel` publishes port 4310 in full, so every page and every server
 * action is reachable from the public hostname Meta talks to. Everything here is
 * closed by default; the exceptions below are the paths that must answer to
 * someone who cannot log in.
 *
 * In Next 16 this file convention is `proxy.ts` — `middleware.ts` is deprecated
 * and silently ignored, which would leave the panel wide open while looking
 * protected.
 */

/** Meta calls this unauthenticated, with its own HMAC signature as the proof. */
const WEBHOOK_PATH = '/api/webhooks/instagram';

/** Used by `pnpm tunnel` to check the panel is up before starting the tunnel. */
const HEALTH_PATH = '/api/health';

const LOGIN_PAGE = '/entrar';
const LOGIN_ENDPOINT = '/api/auth/login';

/**
 * The install surface. A browser fetches all of this before anyone signs in,
 * and it decides whether to offer "add to home screen" from what it gets back.
 * Redirect any of it to /entrar and the prompt never appears — the panel keeps
 * working in the browser, so the failure is silent. None of these files carry
 * operational data; they are an icon, a name and a cache policy.
 */
const INSTALL_PATHS = new Set(['/manifest.webmanifest', '/sw.js', '/offline.html']);
const INSTALL_PREFIX = '/icons/';

function isPublic(pathname: string): boolean {
  return (
    pathname === WEBHOOK_PATH ||
    pathname === HEALTH_PATH ||
    pathname === LOGIN_PAGE ||
    pathname === LOGIN_ENDPOINT ||
    INSTALL_PATHS.has(pathname) ||
    pathname.startsWith(INSTALL_PREFIX)
  );
}

export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  if (isPublic(pathname)) return NextResponse.next();

  const password = process.env.PANEL_PASSWORD?.trim();
  if (!password) {
    // Refusing is the safe default: a missing password must never be read as
    // "no gate configured, let everyone through".
    return new NextResponse(
      'PANEL_PASSWORD não está configurado no .env. O painel fica fechado até que esteja.',
      { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } },
    );
  }

  const cookie = request.cookies.get(PANEL_COOKIE)?.value;
  if (cookie && safeEqual(cookie, await sessionToken(password))) return NextResponse.next();

  const destination = pathname === '/' ? LOGIN_PAGE : `${LOGIN_PAGE}?destino=${encodeURIComponent(`${pathname}${search}`)}`;
  return NextResponse.redirect(new URL(destination, publicOrigin(request)));
}

/**
 * The address the browser actually used, which is not the one this process sees.
 *
 * Behind `pnpm tunnel` the panel answers at a public HTTPS hostname while the
 * request arrives as `http://localhost:4310/...`. Redirecting to that is how a
 * phone ends up at `https://localhost:4310` and fails with
 * ERR_SSL_PROTOCOL_ERROR — signed in, staring at an error page. A relative
 * Location would sidestep the whole question, but Next rejects one here with
 * "Invalid URL", so the origin has to be reconstructed.
 *
 * `x-forwarded-host` decides where the operator's browser is sent next, and
 * anything upstream can set it. So it is honoured only when it matches the
 * hostname the tunnel itself recorded in PUBLIC_WEBHOOK_URL; a forged header
 * falls back to this process's own origin rather than becoming an open redirect
 * on a login page.
 */
function publicOrigin(request: NextRequest): string {
  const own = new URL(request.url).origin;
  const forwardedHost = request.headers.get('x-forwarded-host') ?? request.headers.get('host');
  if (!forwardedHost) return own;

  const publicUrl = process.env.PUBLIC_WEBHOOK_URL?.trim();
  if (!publicUrl) return own;

  let expected: string;
  try {
    expected = new URL(publicUrl).host;
  } catch {
    return own;
  }
  if (forwardedHost.toLowerCase() !== expected.toLowerCase()) return own;

  const proto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
  return `${proto === 'http' ? 'http' : 'https'}://${forwardedHost}`;
}

export const config = {
  // Everything except Next's own static output, which carries no data.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
