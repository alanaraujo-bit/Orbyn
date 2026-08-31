import { eq } from 'drizzle-orm';
import { getDb, type Db } from '@/db/client';
import { conversations, leads, messages, type MessageRow } from '@/db/schema';
import { AppError } from '@/lib/errors';
import { newId } from '@/lib/ids';
import { nowIso } from '@/lib/time';
import { recordEvent } from '@/lib/audit';
import { getBusinessConfig } from '@/config/business';
import { validateOutboundText } from './message-policy';

export interface OutboundMessageInput {
  conversationId: string;
  leadId: string;
  channel: 'browser' | 'api' | 'system';
  body: string;
  /** Stable key that makes a re-run of the same job a no-op. */
  idempotencyKey: string;
  experimentId?: string | null;
  variantId?: string | null;
  jobId?: string | null;
  externalMessageId?: string | null;
  meta?: Record<string, unknown>;
  sentAt?: string;
}

export interface OutboundRecordResult {
  message: MessageRow;
  duplicate: boolean;
}

/**
 * Single persistence point for outbound messages. The unique index on
 * `idempotency_key` is what makes duplicate delivery impossible even if a job
 * is retried after a crash.
 */
export function recordOutboundMessage(input: OutboundMessageInput, db: Db = getDb()): OutboundRecordResult {
  const policy = validateOutboundText(input.body, getBusinessConfig());
  if (!policy.ok) {
    throw new AppError('ai_unsafe_output', 'Mensagem reprovada pela política de conteúdo.', {
      details: { violations: policy.violations },
    });
  }

  const existing = db.select().from(messages).where(eq(messages.idempotencyKey, input.idempotencyKey)).get();
  if (existing) return { message: existing, duplicate: true };

  const now = nowIso();
  const row: MessageRow = {
    id: newId('msg'),
    conversationId: input.conversationId,
    leadId: input.leadId,
    direction: 'outbound',
    channel: input.channel,
    body: input.body,
    intent: null,
    experimentId: input.experimentId ?? null,
    variantId: input.variantId ?? null,
    jobId: input.jobId ?? null,
    externalMessageId: input.externalMessageId ?? null,
    idempotencyKey: input.idempotencyKey,
    meta: JSON.stringify(input.meta ?? {}),
    sentAt: input.sentAt ?? now,
    createdAt: now,
  };

  try {
    db.insert(messages).values(row).run();
  } catch (error) {
    const again = db.select().from(messages).where(eq(messages.idempotencyKey, input.idempotencyKey)).get();
    if (again) return { message: again, duplicate: true };
    throw error;
  }

  db.update(conversations)
    .set({ lastMessageAt: row.sentAt, updatedAt: now })
    .where(eq(conversations.id, input.conversationId))
    .run();
  db.update(leads).set({ lastOutboundAt: row.sentAt, updatedAt: now }).where(eq(leads.id, input.leadId)).run();

  recordEvent(
    {
      type: 'message.outbound',
      leadId: input.leadId,
      conversationId: input.conversationId,
      experimentId: input.experimentId ?? null,
      variantId: input.variantId ?? null,
      payload: { channel: input.channel, chars: input.body.length },
    },
    db,
  );

  return { message: row, duplicate: false };
}

export interface InboundMessageInput {
  conversationId: string;
  leadId: string;
  body: string;
  externalMessageId: string;
  receivedAt: string;
  meta?: Record<string, unknown>;
}

/** Webhook-facing: duplicate deliveries of the same message id are ignored. */
export function recordInboundMessage(input: InboundMessageInput, db: Db = getDb()): OutboundRecordResult {
  const existing = db.select().from(messages).where(eq(messages.externalMessageId, input.externalMessageId)).get();
  if (existing) return { message: existing, duplicate: true };

  const now = nowIso();
  const row: MessageRow = {
    id: newId('msg'),
    conversationId: input.conversationId,
    leadId: input.leadId,
    direction: 'inbound',
    channel: 'api',
    body: input.body,
    intent: null,
    experimentId: null,
    variantId: null,
    jobId: null,
    externalMessageId: input.externalMessageId,
    idempotencyKey: null,
    meta: JSON.stringify(input.meta ?? {}),
    sentAt: input.receivedAt,
    createdAt: now,
  };

  try {
    db.insert(messages).values(row).run();
  } catch (error) {
    const again = db.select().from(messages).where(eq(messages.externalMessageId, input.externalMessageId)).get();
    if (again) return { message: again, duplicate: true };
    throw error;
  }

  db.update(conversations)
    .set({ lastMessageAt: input.receivedAt, lastInboundAt: input.receivedAt, updatedAt: now })
    .where(eq(conversations.id, input.conversationId))
    .run();

  recordEvent(
    {
      type: 'message.inbound',
      leadId: input.leadId,
      conversationId: input.conversationId,
      payload: { chars: input.body.length },
    },
    db,
  );

  return { message: row, duplicate: false };
}

/**
 * Marks an outbound message as actually delivered.
 *
 * Delivery is proven by the provider's message id, not by the row existing:
 * the row is written *before* the request so a crash cannot cause a double
 * send, which means an unstamped row is an attempt whose outcome is unknown.
 */
export function confirmDelivery(
  messageId: string,
  externalMessageId: string,
  db: Db = getDb(),
): void {
  db.update(messages)
    .set({
      externalMessageId,
      sentAt: nowIso(),
      meta: JSON.stringify({ delivered: true }),
    })
    .where(eq(messages.id, messageId))
    .run();
}

/** True when the row was written but delivery was never confirmed. */
export function isUnconfirmed(message: MessageRow): boolean {
  return message.direction === 'outbound' && message.externalMessageId === null;
}

export function setMessageIntent(messageId: string, intent: string, db: Db = getDb()): void {
  db.update(messages).set({ intent }).where(eq(messages.id, messageId)).run();
}
