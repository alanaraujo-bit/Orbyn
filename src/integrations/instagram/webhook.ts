import { createHmac, timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb, type Db } from '@/db/client';
import { webhookEvents } from '@/db/schema';
import { getEnv } from '@/lib/env';
import { newId } from '@/lib/ids';
import { nowIso } from '@/lib/time';
import { raiseAlert, recordEvent } from '@/lib/audit';
import { createLogger } from '@/lib/logger';

const log = createLogger('instagram.webhook');

/**
 * Meta webhook receiver: signature verification, schema validation and
 * idempotent persistence. Nothing here talks to the commercial pipeline
 * directly - it durably records the event and enqueues a job, so a webhook
 * burst can never race the conversation engine.
 */

export const SIGNATURE_HEADER = 'x-hub-signature-256';

export type SignatureCheck = { valid: true } | { valid: false; reason: string };

export function verifySignature(rawBody: string, header: string | null, appSecret: string | undefined): SignatureCheck {
  if (!appSecret) return { valid: false, reason: 'INSTAGRAM_APP_SECRET não configurado.' };
  if (!header) return { valid: false, reason: 'Cabeçalho de assinatura ausente.' };
  const [algorithm, provided] = header.split('=');
  if (algorithm !== 'sha256' || !provided) return { valid: false, reason: 'Formato de assinatura inválido.' };

  const expected = createHmac('sha256', appSecret).update(rawBody, 'utf8').digest('hex');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  const providedBuffer = Buffer.from(provided, 'utf8');
  if (expectedBuffer.length !== providedBuffer.length) return { valid: false, reason: 'Assinatura divergente.' };
  if (!timingSafeEqual(expectedBuffer, providedBuffer)) return { valid: false, reason: 'Assinatura divergente.' };
  return { valid: true };
}

/** Meta's GET verification handshake. */
export function verifySubscription(params: URLSearchParams): { ok: boolean; challenge?: string; reason?: string } {
  const env = getEnv();
  if (!env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN) return { ok: false, reason: 'INSTAGRAM_WEBHOOK_VERIFY_TOKEN não configurado.' };
  if (params.get('hub.mode') !== 'subscribe') return { ok: false, reason: 'hub.mode inválido.' };
  if (params.get('hub.verify_token') !== env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN) {
    return { ok: false, reason: 'hub.verify_token inválido.' };
  }
  const challenge = params.get('hub.challenge');
  if (!challenge) return { ok: false, reason: 'hub.challenge ausente.' };
  return { ok: true, challenge };
}

/**
 * Deliberately permissive.
 *
 * A single delivery can carry several event types at once - a text message next
 * to a read receipt, a reaction, a seen marker. Read receipts arrive WITHOUT
 * `sender`/`recipient` (observed live on 2026-08-30). Requiring those fields
 * made the whole batch fail schema validation with a 400, so a real message
 * riding along with a receipt would be lost and retried forever.
 *
 * A webhook receiver has to accept whatever the platform sends and pick out
 * what it understands. Validation of the fields we actually use happens in
 * `toInbound`, not here.
 */
const messagingEventSchema = z.object({
  sender: z.object({ id: z.string().min(1) }).optional(),
  recipient: z.object({ id: z.string().min(1) }).optional(),
  timestamp: z.union([z.number(), z.string()]).optional(),
  message: z
    .object({
      mid: z.string().min(1),
      text: z.string().optional(),
      is_echo: z.boolean().optional(),
      is_deleted: z.boolean().optional(),
    })
    .optional(),
});

/**
 * Meta delivers Instagram message events in two different envelopes, and which
 * one arrives depends on the product surface:
 *
 *   entry[].messaging[]            - Messenger-style envelope
 *   entry[].changes[] {field,value} - Instagram webhooks envelope
 *
 * Verified on 2026-08-30: the console's own "Enviar para servidor" test for the
 * `messages` field delivers the `changes` shape. Reading only `messaging`
 * meant every real message was silently dropped with a 200. Both are supported.
 */
const changeSchema = z.object({
  field: z.string(),
  value: messagingEventSchema.passthrough(),
});

export const webhookPayloadSchema = z.object({
  object: z.string(),
  entry: z.array(
    z.object({
      id: z.string(),
      time: z.number().optional(),
      messaging: z.array(messagingEventSchema).optional(),
      changes: z.array(changeSchema).optional(),
    }),
  ),
});

export type WebhookPayload = z.infer<typeof webhookPayloadSchema>;

export interface InboundMessageEvent {
  externalId: string;
  senderId: string;
  recipientId: string;
  text: string;
  receivedAt: string;
}

/** Message-bearing webhook fields; anything else (comments, seen) is ignored. */
const MESSAGE_FIELDS = new Set(['messages', 'message_edit']);

type MessagingEvent = z.infer<typeof messagingEventSchema>;

/**
 * Turns one event into an inbound message, or null when it is not one we act
 * on: a read receipt, a reaction, an echo of our own message, a deletion, or
 * anything without the identities we need to answer.
 */
function toInbound(event: MessagingEvent): InboundMessageEvent | null {
  const message = event.message;
  if (!message || message.is_echo === true || message.is_deleted === true) return null;
  if (!message.text || message.text.trim().length === 0) return null;
  if (!event.sender?.id || !event.recipient?.id) return null;
  return {
    externalId: message.mid,
    senderId: event.sender.id,
    recipientId: event.recipient.id,
    text: message.text,
    receivedAt: normalizeTimestamp(event.timestamp),
  };
}

/**
 * Meta sends the timestamp as epoch milliseconds in one envelope and as a
 * seconds string in the other. Anything before 2001 is assumed to be seconds.
 */
function normalizeTimestamp(value: number | string | undefined): string {
  if (value === undefined) return nowIso();
  const numeric = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(numeric) || numeric <= 0) return nowIso();
  const ms = numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? nowIso() : date.toISOString();
}

export function extractInboundMessages(payload: WebhookPayload): InboundMessageEvent[] {
  const messages: InboundMessageEvent[] = [];
  const seen = new Set<string>();

  const push = (event: MessagingEvent): void => {
    const inbound = toInbound(event);
    // The same message can appear in both envelopes; dedupe on the provider id.
    if (!inbound || seen.has(inbound.externalId)) return;
    seen.add(inbound.externalId);
    messages.push(inbound);
  };

  for (const entry of payload.entry) {
    for (const event of entry.messaging ?? []) push(event);
    for (const change of entry.changes ?? []) {
      if (!MESSAGE_FIELDS.has(change.field)) continue;
      push(change.value as MessagingEvent);
    }
  }
  return messages;
}

export type StoreResult = { status: 'stored'; id: string } | { status: 'duplicate'; id: string };

/** Idempotent: Meta retries deliveries and each `mid` may arrive many times. */
export function storeWebhookEvent(event: InboundMessageEvent, rawPayload: string, db: Db = getDb()): StoreResult {
  const existing = db.select().from(webhookEvents).where(eq(webhookEvents.externalId, event.externalId)).get();
  if (existing) return { status: 'duplicate', id: existing.id };

  const id = newId('wh');
  try {
    db.insert(webhookEvents)
      .values({
        id,
        provider: 'instagram',
        externalId: event.externalId,
        signatureValid: 1,
        status: 'received',
        payload: rawPayload.slice(0, 20_000),
        receivedAt: nowIso(),
      })
      .run();
  } catch {
    const again = db.select().from(webhookEvents).where(eq(webhookEvents.externalId, event.externalId)).get();
    if (again) return { status: 'duplicate', id: again.id };
    throw new Error('failed to persist webhook event');
  }
  return { status: 'stored', id };
}

export function markWebhookProcessed(
  id: string,
  status: 'processed' | 'ignored' | 'failed',
  error: string | null,
  db: Db = getDb(),
): void {
  db.update(webhookEvents)
    .set({ status, error, processedAt: nowIso() })
    .where(eq(webhookEvents.id, id))
    .run();
}

export function reportInvalidSignature(reason: string, db: Db = getDb()): void {
  log.warn('rejected webhook delivery', { reason });
  recordEvent({ type: 'webhook.signature_invalid', payload: { reason } }, db);
  raiseAlert(
    {
      kind: 'integration',
      severity: 'critical',
      code: 'webhook_signature_invalid',
      title: 'Webhook do Instagram com assinatura inválida',
      detail: reason,
      dedupeKey: 'integration:webhook_signature_invalid',
    },
    db,
  );
}
