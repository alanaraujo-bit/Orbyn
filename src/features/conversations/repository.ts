import { asc, desc, eq } from 'drizzle-orm';
import { getDb, type Db } from '@/db/client';
import { conversations, leads, messages, type ConversationRow, type MessageRow } from '@/db/schema';
import { AppError } from '@/lib/errors';
import { newId } from '@/lib/ids';
import { nowIso } from '@/lib/time';
import type { ChannelOwner, Funnel } from '@/features/leads/states';

export function getConversation(id: string, db: Db = getDb()): ConversationRow {
  const row = db.select().from(conversations).where(eq(conversations.id, id)).get();
  if (!row) throw new AppError('not_found', `Conversa ${id} não encontrada.`);
  return row;
}

export function findConversationByLead(leadId: string, db: Db = getDb()): ConversationRow | undefined {
  return db.select().from(conversations).where(eq(conversations.leadId, leadId)).get();
}

/** One conversation per lead; creation is idempotent. */
export function ensureConversation(leadId: string, funnel: Funnel, db: Db = getDb()): ConversationRow {
  const existing = findConversationByLead(leadId, db);
  if (existing) return existing;
  const now = nowIso();
  const row: ConversationRow = {
    id: newId('conv'),
    leadId,
    funnel,
    channelOwner: 'none',
    status: 'open',
    lastMessageAt: null,
    lastInboundAt: null,
    apiWindowExpiresAt: null,
    humanReviewReason: null,
    createdAt: now,
    updatedAt: now,
  };
  db.insert(conversations).values(row).run();
  return row;
}

export function setConversationOwner(id: string, owner: ChannelOwner, db: Db = getDb()): void {
  db.update(conversations).set({ channelOwner: owner, updatedAt: nowIso() }).where(eq(conversations.id, id)).run();
}

export function setConversationStatus(
  id: string,
  status: 'open' | 'waiting_reply' | 'human_review' | 'closed',
  reason: string | null,
  db: Db = getDb(),
): void {
  db.update(conversations)
    .set({ status, humanReviewReason: status === 'human_review' ? reason : null, updatedAt: nowIso() })
    .where(eq(conversations.id, id))
    .run();
}

export function listMessages(conversationId: string, db: Db = getDb()): MessageRow[] {
  return db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.createdAt))
    .all();
}

export function lastOutboundMessage(conversationId: string, db: Db = getDb()): MessageRow | undefined {
  return db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(desc(messages.createdAt))
    .all()
    .find((message) => message.direction === 'outbound');
}

export interface ConversationWithLead {
  conversation: ConversationRow;
  lead: typeof leads.$inferSelect;
}

export function conversationWithLead(conversationId: string, db: Db = getDb()): ConversationWithLead {
  const conversation = getConversation(conversationId, db);
  const lead = db.select().from(leads).where(eq(leads.id, conversation.leadId)).get();
  if (!lead) throw new AppError('not_found', `Lead da conversa ${conversationId} não encontrado.`);
  return { conversation, lead };
}
