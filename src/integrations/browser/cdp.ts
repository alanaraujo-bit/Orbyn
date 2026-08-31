import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { getEnv } from '@/lib/env';
import { AppError } from '@/lib/errors';
import { createLogger } from '@/lib/logger';

const log = createLogger('browser.cdp');

/**
 * Attaches to the Chrome the operator already has open, over the local
 * debugging port.
 *
 * Non-negotiable behaviours:
 *  - never launch a browser of our own when the attach fails;
 *  - never adopt one of the operator's tabs - we always open our own;
 *  - never call `bringToFront()` and never touch the OS mouse or keyboard;
 *  - always close our tab, including on failure;
 *  - only allow traffic to the domains the task needs.
 */

export const ALLOWED_HOSTS = [
  'www.instagram.com',
  'instagram.com',
  'i.instagram.com',
  'static.cdninstagram.com',
  'scontent.cdninstagram.com',
];

export interface CdpSession {
  browser: Browser;
  context: BrowserContext;
}

export async function connectToChrome(): Promise<CdpSession> {
  const env = getEnv();
  if (!env.CHROME_CDP_URL) {
    throw new AppError('browser_unavailable', 'CHROME_CDP_URL não configurada.', { details: { capability: 'browser_outreach' } });
  }
  let browser: Browser;
  try {
    browser = await chromium.connectOverCDP(env.CHROME_CDP_URL, { timeout: 10_000 });
  } catch (error) {
    throw new AppError('browser_unavailable', 'Não foi possível conectar ao Chrome do operador.', {
      cause: error,
      details: { cdpUrl: env.CHROME_CDP_URL },
      retryable: true,
    });
  }

  const context = browser.contexts()[0];
  if (!context) {
    await browser.close().catch(() => undefined);
    throw new AppError('browser_unavailable', 'Chrome conectado, mas sem contexto autenticado disponível.', {
      retryable: true,
    });
  }
  return { browser, context };
}

function isAllowedHost(hostname: string): boolean {
  return ALLOWED_HOSTS.some((host) => hostname === host || hostname.endsWith(`.${host}`));
}

/**
 * Opens a dedicated agent tab, restricts it to the hosts the job needs, and
 * guarantees it is closed. The operator's own tabs are never touched.
 */
export async function withAgentPage<T>(
  session: CdpSession,
  fn: (page: Page, diagnostics: PageDiagnostics) => Promise<T>,
): Promise<T> {
  const page = await session.context.newPage();
  const diagnostics: PageDiagnostics = { consoleErrors: [], failedRequests: [] };

  page.on('console', (message) => {
    if (message.type() === 'error') diagnostics.consoleErrors.push(message.text().slice(0, 300));
  });
  page.on('requestfailed', (request) => {
    diagnostics.failedRequests.push(`${request.method()} ${request.url().slice(0, 200)}`);
  });

  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.protocol === 'data:' || url.protocol === 'blob:' || isAllowedHost(url.hostname)) {
      await route.continue();
      return;
    }
    await route.abort('blockedbyclient');
  });

  try {
    return await fn(page, diagnostics);
  } finally {
    await page.close({ runBeforeUnload: false }).catch((error: unknown) => {
      log.warn('failed to close agent tab', { error: error instanceof Error ? error.message : String(error) });
    });
  }
}

export interface PageDiagnostics {
  consoleErrors: string[];
  failedRequests: string[];
}

/** Detaches from the operator's Chrome without closing it. */
export async function disconnect(session: CdpSession): Promise<void> {
  await session.browser.close().catch(() => undefined);
}
