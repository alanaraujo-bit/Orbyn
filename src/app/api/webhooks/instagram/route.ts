import { NextResponse } from 'next/server';
import { getDb } from '@/db/client';
import { getEnv } from '@/lib/env';
import { idempotencyKey } from '@/lib/ids';
import { createLogger } from '@/lib/logger';
import { recordBreakerFailure, recordBreakerSuccess } from '@/lib/circuit-breaker';
import {
  extractInboundMessages,
  reportInvalidSignature,
  SIGNATURE_HEADER,
  storeWebhookEvent,
  verifySignature,
  verifySubscription,
  webhookPayloadSchema,
} from '@/integrations/instagram/webhook';
import { enqueue } from '@/worker/queue';
import { raiseAlert } from '@/lib/audit';

/** Key structure only - never values, which may carry message contents. */
function describeShape(value: unknown, depth = 0): unknown {
  if (depth > 4) return '...';
  if (Array.isArray(value)) return value.length === 0 ? [] : [describeShape(value[0], depth + 1)];
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = describeShape(v, depth + 1);
    return out;
  }
  return typeof value;
}

const log = createLogger('webhook.route');

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Meta webhook endpoint.
 *
 * The handler is deliberately thin: verify, persist, enqueue, acknowledge. All
 * commercial logic runs in the worker, so a slow model call can never make Meta
 * time out and retry the delivery.
 */

export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const result = verifySubscription(params);
  if (!result.ok) {
    log.warn('subscription verification refused', { reason: result.reason });
    return new NextResponse('forbidden', { status: 403 });
  }
  return new NextResponse(result.challenge, { status: 200, headers: { 'content-type': 'text/plain' } });
}

export async function POST(request: Request): Promise<Response> {
  const db = getDb();
  const raw = await request.text();
  const signature = request.headers.get(SIGNATURE_HEADER);

  const check = verifySignature(raw, signature, getEnv().INSTAGRAM_APP_SECRET);
  if (!check.valid) {
    reportInvalidSignature(check.reason, db);
    recordBreakerFailure('webhook', `signature: ${check.reason}`, db);
    return new NextResponse('invalid signature', { status: 401 });
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    return new NextResponse('invalid json', { status: 400 });
  }

  const parsed = webhookPayloadSchema.safeParse(parsedJson);
  if (!parsed.success) {
    // A rejected payload is a real incident: Meta delivered something we cannot
    // read, and every retry will fail the same way. Log enough structure to fix
    // it without ever dumping message contents.
    log.warn('webhook payload rejected by schema', {
      issues: parsed.error.issues.slice(0, 8).map((issue) => `${issue.path.join('.')}: ${issue.message}`),
      shape: describeShape(parsedJson),
    });
    raiseAlert(
      {
        kind: 'integration',
        severity: 'critical',
        code: 'webhook_payload_unreadable',
        title: 'Webhook recebido em formato não reconhecido',
        detail: 'A Meta entregou um evento que o sistema não conseguiu interpretar. Nenhuma mensagem foi processada.',
        context: { issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`) },
        dedupeKey: 'integration:webhook_payload_unreadable',
      },
      db,
    );
    return new NextResponse('invalid payload', { status: 400 });
  }

  let accepted = 0;
  let duplicated = 0;

  for (const message of extractInboundMessages(parsed.data)) {
    const stored = storeWebhookEvent(message, raw, db);
    if (stored.status === 'duplicate') {
      duplicated += 1;
      continue;
    }
    accepted += 1;
    enqueue(
      {
        type: 'process_inbound',
        payload: { webhookEventId: stored.id },
        idempotencyKey: idempotencyKey('process_inbound', message.externalId),
        priority: 5,
        maxAttempts: 5,
      },
      db,
    );
  }

  recordBreakerSuccess('webhook', db);
  log.info('webhook delivery accepted', { accepted, duplicated });
  return NextResponse.json({ accepted, duplicated });
}
