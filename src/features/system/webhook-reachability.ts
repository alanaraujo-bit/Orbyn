import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { parse as parseDotenv } from 'dotenv';
import { getDb, type Db } from '@/db/client';
import { alerts } from '@/db/schema';
import { getEnv } from '@/lib/env';
import { raiseAlert, recordEvent } from '@/lib/audit';
import { createLogger } from '@/lib/logger';
import { nowIso } from '@/lib/time';
import { sleep } from '@/lib/sleep';

const log = createLogger('system.webhook-reachability');

/**
 * Proves that the public webhook address still reaches this machine.
 *
 * The failure this guards against is silent by construction: when the tunnel
 * dies, Meta keeps delivering to the dead hostname and reports nothing back to
 * us. Nothing in the system errors - inbound traffic simply stops, and the
 * panel looks healthy while leads go unanswered.
 *
 * So the check cannot be passive. It re-runs Meta's own subscription handshake
 * against the public URL with a fresh random challenge, and only counts the
 * address as alive when that exact challenge comes back through the tunnel.
 * A cached page, a Cloudflare error page or somebody else's server all fail it.
 */

export const WEBHOOK_UNREACHABLE_DEDUPE_KEY = 'integration:webhook_unreachable';

export const DEFAULT_PROBE_TIMEOUT_MS = 10_000;

/** Attempts inside a single check, so one dropped packet is not an incident. */
const ATTEMPTS_PER_CHECK = 2;
const DELAY_BETWEEN_ATTEMPTS_MS = 3_000;

export type ReachabilityResult =
  | { status: 'skipped'; reason: string }
  | { status: 'reachable'; url: string; latencyMs: number }
  | { status: 'unreachable'; url: string; reason: string; severity: 'warning' | 'critical' };

export interface ProbeOptions {
  db?: Db;
  /** Where the live public address is read from. Overridden in tests. */
  envFilePath?: string;
  /** Injectable transport so tests never touch the network. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Test seam: skips the wait between attempts. */
  delayBetweenAttemptsMs?: number;
}

/**
 * Reads the public address as it stands *now*, not as it stood at boot.
 *
 * `pnpm tunnel` rewrites PUBLIC_WEBHOOK_URL in `.env` on every start, but the
 * worker parsed its environment once and cached it. Trusting that cache would
 * invert this whole check: after a tunnel restart the watchdog would keep
 * probing the dead hostname it remembers, raise an alert about an address the
 * operator already replaced, and never look at the live one.
 */
function readCurrentPublicUrl(envFilePath: string | undefined): string | undefined {
  const filePath = envFilePath ?? path.resolve(process.cwd(), '.env');
  try {
    const fromFile = parseDotenv(readFileSync(filePath, 'utf8')).PUBLIC_WEBHOOK_URL?.trim();
    // Reading the file bypasses the schema that validated this key at boot, so
    // re-apply the same rule here. A hand-edited value must not throw out of the
    // probe: this module's job is to report, never to take the worker down.
    if (fromFile && new URL(fromFile).protocol === 'https:') return fromFile;
  } catch {
    // No readable .env here (a packaged deploy, a test), or a value that is not
    // a URL at all: fall back to the environment the process was started with.
  }
  return getEnv().PUBLIC_WEBHOOK_URL;
}

function describeFailure(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') return 'a URL pública não respondeu a tempo';
    // Node wraps DNS/TCP failures; the cause carries the useful code.
    const cause = (error as { cause?: { code?: string } }).cause;
    if (cause?.code === 'ENOTFOUND') return 'o endereço público não existe mais (DNS não resolve)';
    if (cause?.code === 'ECONNREFUSED') return 'o endereço público recusou a conexão';
    return error.message;
  }
  return String(error);
}

function openAlertRow(db: Db): { id: string; severity: string } | undefined {
  return db
    .select({ id: alerts.id, severity: alerts.severity })
    .from(alerts)
    .where(and(eq(alerts.dedupeKey, WEBHOOK_UNREACHABLE_DEDUPE_KEY), eq(alerts.status, 'open')))
    .all()[0];
}

/**
 * Resolves the open unreachability alert, if any. Recovery has to clear the
 * alert on its own: an operator who reads "webhook fora do ar" on a panel where
 * the webhook is already back learns to distrust the panel.
 */
function clearOpenAlert(db: Db): boolean {
  const open = db
    .select({ id: alerts.id })
    .from(alerts)
    .where(and(eq(alerts.dedupeKey, WEBHOOK_UNREACHABLE_DEDUPE_KEY), eq(alerts.status, 'open')))
    .all();
  for (const row of open) {
    db.update(alerts).set({ status: 'resolved', updatedAt: nowIso() }).where(eq(alerts.id, row.id)).run();
  }
  return open.length > 0;
}

/** One handshake round trip. Returns undefined on success, or why it failed. */
async function attemptHandshake(
  url: URL,
  challenge: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<string | undefined> {
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = (await response.text()).trim();
    if (!response.ok) return `a URL pública respondeu HTTP ${response.status}`;
    if (body !== challenge) {
      // Reached something, but not us. This is the shape a recycled tunnel
      // hostname takes: another tenant now answers on that address.
      return 'a URL pública respondeu, mas não é este sistema que está atendendo nela';
    }
    return undefined;
  } catch (error) {
    return describeFailure(error);
  }
}

export async function probeWebhookReachability(options: ProbeOptions = {}): Promise<ReachabilityResult> {
  const db = options.db ?? getDb();
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const env = getEnv();

  const publicUrl = readCurrentPublicUrl(options.envFilePath);
  if (!publicUrl) return { status: 'skipped', reason: 'PUBLIC_WEBHOOK_URL não configurado.' };
  const verifyToken = env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN;
  if (!verifyToken) return { status: 'skipped', reason: 'INSTAGRAM_WEBHOOK_VERIFY_TOKEN não configurado.' };

  const startedAt = Date.now();
  let failure: string | undefined;
  for (let attempt = 0; attempt < ATTEMPTS_PER_CHECK; attempt += 1) {
    if (attempt > 0) await sleep(options.delayBetweenAttemptsMs ?? DELAY_BETWEEN_ATTEMPTS_MS);
    // A fresh challenge per attempt: a stale echo must never pass for a live one.
    const challenge = randomUUID();
    const url = new URL(publicUrl);
    url.searchParams.set('hub.mode', 'subscribe');
    url.searchParams.set('hub.verify_token', verifyToken);
    url.searchParams.set('hub.challenge', challenge);
    failure = await attemptHandshake(url, challenge, fetchImpl, timeoutMs);
    if (failure === undefined) break;
  }

  if (failure === undefined) {
    const latencyMs = Date.now() - startedAt;
    if (clearOpenAlert(db)) {
      log.info('public webhook address recovered', { latencyMs });
      recordEvent({ type: 'webhook.reachability.recovered', payload: { latencyMs } }, db);
    }
    return { status: 'reachable', url: publicUrl, latencyMs };
  }

  // The open alert doubles as the consecutive-failure counter, so no extra state
  // is needed: the first bad check warns, the next one escalates. A watchdog
  // that screams at the first dropped packet is a watchdog the operator mutes.
  const existing = openAlertRow(db);
  const severity: 'warning' | 'critical' = existing ? 'critical' : 'warning';
  const detail =
    `A Meta continua entregando as respostas dos leads em ${publicUrl}, mas esse endereço não chega mais até aqui: ` +
    `${failure}. Enquanto isso durar, nenhuma resposta de lead será recebida, e a Meta não avisa. ` +
    'Reinicie o túnel com "pnpm tunnel" e atualize a Callback URL no painel da Meta.';

  log.error('public webhook address unreachable', { reason: failure, severity });

  if (existing) {
    db.update(alerts)
      .set({
        severity,
        detail,
        context: JSON.stringify({ url: publicUrl, reason: failure }),
        updatedAt: nowIso(),
      })
      .where(eq(alerts.id, existing.id))
      .run();
  } else {
    raiseAlert(
      {
        kind: 'integration',
        severity,
        code: 'webhook_unreachable',
        title: 'O endereço público do webhook parou de responder',
        detail,
        context: { url: publicUrl, reason: failure },
        dedupeKey: WEBHOOK_UNREACHABLE_DEDUPE_KEY,
      },
      db,
    );
  }

  return { status: 'unreachable', url: publicUrl, reason: failure, severity };
}
