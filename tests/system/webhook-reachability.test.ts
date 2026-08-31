import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { withTestDatabase } from '../helpers/db';
import { getDb } from '@/db/client';
import { alerts } from '@/db/schema';
import { resetEnvCache } from '@/lib/env';
import {
  probeWebhookReachability,
  WEBHOOK_UNREACHABLE_DEDUPE_KEY,
} from '@/features/system/webhook-reachability';

withTestDatabase();

const VERIFY_TOKEN = 'token-de-verificacao';
const PUBLIC_URL = 'https://exemplo.trycloudflare.com/api/webhooks/instagram';

beforeEach(() => {
  process.env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN = VERIFY_TOKEN;
  process.env.PUBLIC_WEBHOOK_URL = PUBLIC_URL;
  resetEnvCache();
});

/** A path with no `.env` behind it, so the probe falls back to process.env. */
const NO_ENV_FILE = path.join(tmpdir(), 'orbyn-sem-env-file', '.env');

/** No waiting between the two attempts a single check makes. */
function probe(fetchImpl: typeof fetch, envFilePath: string = NO_ENV_FILE) {
  return probeWebhookReachability({ fetchImpl, delayBetweenAttemptsMs: 0, envFilePath });
}

/** A transport that answers the handshake the way the real endpoint does. */
function echoingFetch(): typeof fetch {
  return (async (input: URL | RequestInfo) => {
    const url = new URL(input instanceof URL ? input : String(input));
    expect(url.searchParams.get('hub.mode')).toBe('subscribe');
    expect(url.searchParams.get('hub.verify_token')).toBe(VERIFY_TOKEN);
    return new Response(url.searchParams.get('hub.challenge') ?? '', { status: 200 });
  }) as typeof fetch;
}

function dnsFailureFetch(): typeof fetch {
  return (async () => {
    const error = new Error('fetch failed');
    (error as { cause?: { code: string } }).cause = { code: 'ENOTFOUND' };
    throw error;
  }) as typeof fetch;
}

function openAlerts() {
  return getDb()
    .select()
    .from(alerts)
    .where(eq(alerts.dedupeKey, WEBHOOK_UNREACHABLE_DEDUPE_KEY))
    .all()
    .filter((row) => row.status === 'open');
}

describe('public webhook reachability', () => {
  it('counts the address as alive only when the exact challenge echoes back', async () => {
    const result = await probe(echoingFetch());

    expect(result.status).toBe('reachable');
    expect(openAlerts()).toHaveLength(0);
  });

  it('survives a single dropped request inside one check', async () => {
    // One blip then a good answer must not register as an outage at all.
    let calls = 0;
    const flaky = (async (input: URL | RequestInfo) => {
      calls += 1;
      if (calls === 1) throw new Error('socket hang up');
      const url = new URL(input instanceof URL ? input : String(input));
      return new Response(url.searchParams.get('hub.challenge') ?? '', { status: 200 });
    }) as typeof fetch;

    const result = await probe(flaky);

    expect(calls).toBe(2);
    expect(result.status).toBe('reachable');
    expect(openAlerts()).toHaveLength(0);
  });

  it('warns on the first bad check rather than crying wolf', async () => {
    const result = await probe(dnsFailureFetch());

    expect(result.status).toBe('unreachable');
    const open = openAlerts();
    expect(open).toHaveLength(1);
    expect(open[0]?.severity).toBe('warning');
    expect(open[0]?.code).toBe('webhook_unreachable');
  });

  it('escalates the same alert to critical on the second consecutive failure', async () => {
    await probe(dnsFailureFetch());
    const result = await probe(dnsFailureFetch());

    expect(result.status).toBe('unreachable');
    const open = openAlerts();
    // Escalated in place: one incident, not two.
    expect(open).toHaveLength(1);
    expect(open[0]?.severity).toBe('critical');
  });

  it('treats a 200 from somebody else as unreachable', async () => {
    // The hostname was recycled and another tenant answers on it. Meta's
    // deliveries would be accepted by a stranger, and nothing would look broken.
    const stranger = (async () => new Response('<html>hello</html>', { status: 200 })) as typeof fetch;

    const result = await probe(stranger);

    expect(result.status).toBe('unreachable');
    expect(openAlerts()).toHaveLength(1);
  });

  it('does not pile up one alert per check while the outage lasts', async () => {
    const down = (async () => new Response('bad gateway', { status: 502 })) as typeof fetch;

    await probe(down);
    await probe(down);
    await probe(down);

    expect(openAlerts()).toHaveLength(1);
  });

  it('resolves the alert on its own once the address answers again', async () => {
    const down = (async () => new Response('bad gateway', { status: 502 })) as typeof fetch;
    await probe(down);
    expect(openAlerts()).toHaveLength(1);

    const result = await probe(echoingFetch());

    expect(result.status).toBe('reachable');
    expect(openAlerts()).toHaveLength(0);
  });

  it('follows the address .env holds now, not the one cached at boot', async () => {
    // The failure this guards against: `pnpm tunnel` rewrites .env while the
    // worker runs, and the worker's env cache still names the dead hostname.
    const dir = mkdtempSync(path.join(tmpdir(), 'orbyn-tunnel-'));
    const envFile = path.join(dir, '.env');
    const novaUrl = 'https://hostname-novo.trycloudflare.com/api/webhooks/instagram';
    writeFileSync(envFile, `PUBLIC_WEBHOOK_URL=${novaUrl}
`);

    const probed: string[] = [];
    const recording = (async (input: URL | RequestInfo) => {
      const url = new URL(input instanceof URL ? input : String(input));
      probed.push(url.origin + url.pathname);
      return new Response(url.searchParams.get('hub.challenge') ?? '', { status: 200 });
    }) as typeof fetch;

    const result = await probe(recording, envFile);

    expect(result.status).toBe('reachable');
    expect(probed).toEqual([new URL(novaUrl).origin + new URL(novaUrl).pathname]);
  });

  it('falls back to the boot environment when .env holds something unusable', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'orbyn-tunnel-'));
    const envFile = path.join(dir, '.env');
    writeFileSync(envFile, 'PUBLIC_WEBHOOK_URL=nao-e-uma-url\n');

    // A hand-edited .env must not take the worker down; the probe reports on the
    // address it can still trust instead of throwing out of the handler.
    const result = await probe(echoingFetch(), envFile);

    expect(result.status).toBe('reachable');
    expect(result).toMatchObject({ url: PUBLIC_URL });
  });

  it('stays quiet when no public address is configured', async () => {
    delete process.env.PUBLIC_WEBHOOK_URL;
    resetEnvCache();

    const result = await probe((() => {
      throw new Error('a verificação não deveria chamar a rede');
    }) as unknown as typeof fetch);

    expect(result.status).toBe('skipped');
    expect(openAlerts()).toHaveLength(0);
  });
});
