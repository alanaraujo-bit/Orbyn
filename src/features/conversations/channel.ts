import { eq } from 'drizzle-orm';
import { getDb, type Db } from '@/db/client';
import { conversations, leads, type ConversationRow, type LeadRow } from '@/db/schema';
import { AppError, type ErrorCode } from '@/lib/errors';
import { addHours, nowIso } from '@/lib/time';
import { recordAudit, recordEvent } from '@/lib/audit';
import { isSuppressed } from '@/features/leads/suppression';
import { transitionChannel } from '@/features/leads/repository';
import { allowsOutbound, type ChannelOwner, type ChannelState, type Funnel } from '@/features/leads/states';
import { ensureConversation, findConversationByLead, setConversationOwner, setConversationStatus } from './repository';

/**
 * Channel ownership.
 *
 * Meta's Instagram Messaging API cannot start a conversation: "Only after an
 * Instagram user has sent your app user's Instagram professional account a
 * message can your app send a message to the Instagram user." (Instagram
 * Platform docs, checked 2026-08-30.) So the browser owns the very first
 * message and the API takes over permanently once the lead replies. Exactly one
 * owner exists at any moment, which is what prevents double sends.
 */

/** Standard Instagram messaging window, in hours, per Meta documentation. */
export const IG_MESSAGING_WINDOW_HOURS = 24;

export type OutboundChannel = 'browser' | 'api';

export interface SendGuardContext {
  lead: LeadRow;
  conversation: ConversationRow;
  channel: OutboundChannel;
  now?: Date;
}

export interface SendGuardResult {
  allowed: boolean;
  reason?: string;
  code?: ErrorCode;
}

/** Pure predicate: no writes, no side effects, safe to call from the UI. */
export function evaluateSendGuard(context: SendGuardContext): SendGuardResult {
  const { lead, conversation, channel } = context;
  const now = context.now ?? new Date();

  if (lead.doNotContact === 1 || lead.channelState === 'do_not_contact') {
    return { allowed: false, code: 'suppressed_contact', reason: 'Lead está em não contatar.' };
  }
  if (!allowsOutbound(lead.channelState as ChannelState)) {
    return { allowed: false, code: 'invalid_state_transition', reason: `Canal em estado "${lead.channelState}".` };
  }
  if (conversation.channelOwner !== channel) {
    return {
      allowed: false,
      code: 'channel_ownership_conflict',
      reason: `A conversa pertence ao canal "${conversation.channelOwner}", não a "${channel}".`,
    };
  }
  if (channel === 'browser' && lead.channelState !== 'browser_contact_pending') {
    return {
      allowed: false,
      code: 'channel_ownership_conflict',
      reason: 'O navegador só envia o primeiro contato.',
    };
  }
  if (channel === 'api') {
    if (!lead.platformUserId) {
      return { allowed: false, code: 'api_ineligible_recipient', reason: 'Destinatário sem ID da plataforma.' };
    }
    if (!conversation.apiWindowExpiresAt) {
      return { allowed: false, code: 'api_window_closed', reason: 'Nenhuma janela de resposta aberta.' };
    }
    if (new Date(conversation.apiWindowExpiresAt).getTime() <= now.getTime()) {
      return { allowed: false, code: 'api_window_closed', reason: 'Janela de 24h encerrada.' };
    }
  }
  return { allowed: true };
}

export function assertCanSend(context: SendGuardContext, db: Db = getDb()): void {
  const result = evaluateSendGuard(context);
  if (result.allowed) {
    if (isSuppressed(context.lead.handle, context.lead.platform, db)) {
      throw new AppError('suppressed_contact', 'Handle presente na lista de supressão.');
    }
    return;
  }
  throw new AppError(result.code ?? 'validation_failed', result.reason ?? 'Envio bloqueado.', {
    details: { leadId: context.lead.id, channel: context.channel, channelState: context.lead.channelState },
  });
}

/**
 * Gives the browser exclusive ownership of the first contact. Refuses if the
 * API already owns the thread.
 */
export function claimBrowserChannel(leadId: string, db: Db = getDb()): ConversationRow {
  const lead = db.select().from(leads).where(eq(leads.id, leadId)).get();
  if (!lead) throw new AppError('not_found', `Lead ${leadId} não encontrado.`);
  const conversation = ensureConversation(leadId, lead.funnel as Funnel, db);
  if (conversation.channelOwner === 'api') {
    throw new AppError('channel_ownership_conflict', 'A API já é dona desta conversa; o navegador não pode reassumir.', {
      details: { leadId, conversationId: conversation.id },
    });
  }
  if (lead.channelState !== 'browser_contact_pending') {
    throw new AppError('channel_ownership_conflict', `Lead não está aguardando primeiro contato (${lead.channelState}).`, {
      details: { leadId, channelState: lead.channelState },
    });
  }
  if (conversation.channelOwner !== 'browser') {
    setConversationOwner(conversation.id, 'browser', db);
    db.update(leads).set({ channelOwner: 'browser', updatedAt: nowIso() }).where(eq(leads.id, leadId)).run();
  }
  return { ...conversation, channelOwner: 'browser' };
}

export function markBrowserContactSent(leadId: string, db: Db = getDb()): void {
  const conversation = findConversationByLead(leadId, db);
  if (!conversation) throw new AppError('not_found', `Conversa do lead ${leadId} não encontrada.`);
  const now = nowIso();
  transitionChannel({ leadId, to: 'browser_contact_sent', actor: 'worker', reason: 'primeira DM enviada' }, db);
  transitionChannel({ leadId, to: 'waiting_inbound_reply', actor: 'worker', reason: 'aguardando resposta', owner: 'none' }, db);
  db.update(leads).set({ contactedAt: now, lastOutboundAt: now, updatedAt: now }).where(eq(leads.id, leadId)).run();
  setConversationOwner(conversation.id, 'none', db);
  setConversationStatus(conversation.id, 'waiting_reply', null, db);
}

export interface InboundHandoffInput {
  leadId: string;
  receivedAt: string;
  /** Instagram-scoped sender id, required for any later API reply. */
  platformUserId: string;
}

export interface HandoffResult {
  conversation: ConversationRow;
  ownerBefore: ChannelOwner;
  ownerAfter: ChannelOwner;
  apiWindowExpiresAt: string;
}

/**
 * Browser → webhook → API handoff. After this the browser can never send on the
 * thread again: the channel state machine has no edge back to
 * `browser_contact_pending`.
 */
export function handoffToApi(input: InboundHandoffInput, db: Db = getDb()): HandoffResult {
  const lead = db.select().from(leads).where(eq(leads.id, input.leadId)).get();
  if (!lead) throw new AppError('not_found', `Lead ${input.leadId} não encontrado.`);
  const conversation = ensureConversation(lead.id, lead.funnel as Funnel, db);
  const ownerBefore = conversation.channelOwner as ChannelOwner;
  const expiresAt = addHours(new Date(input.receivedAt), IG_MESSAGING_WINDOW_HOURS).toISOString();

  if (lead.doNotContact === 1) {
    db.update(conversations)
      .set({ lastInboundAt: input.receivedAt, updatedAt: nowIso() })
      .where(eq(conversations.id, conversation.id))
      .run();
    return { conversation, ownerBefore, ownerAfter: 'none', apiWindowExpiresAt: expiresAt };
  }

  if (lead.channelState === 'waiting_inbound_reply' || lead.channelState === 'api_window_closed') {
    transitionChannel({ leadId: lead.id, to: 'api_eligible', actor: 'webhook', reason: 'resposta recebida' }, db);
  }

  db.update(leads)
    .set({
      platformUserId: lead.platformUserId ?? input.platformUserId,
      repliedAt: lead.repliedAt ?? input.receivedAt,
      lastInboundAt: input.receivedAt,
      updatedAt: nowIso(),
    })
    .where(eq(leads.id, lead.id))
    .run();

  db.update(conversations)
    .set({
      channelOwner: 'api',
      status: 'open',
      lastInboundAt: input.receivedAt,
      lastMessageAt: input.receivedAt,
      apiWindowExpiresAt: expiresAt,
      updatedAt: nowIso(),
    })
    .where(eq(conversations.id, conversation.id))
    .run();

  recordAudit(
    {
      actor: 'webhook',
      action: 'channel.handoff',
      entityType: 'conversation',
      entityId: conversation.id,
      before: { owner: ownerBefore },
      after: { owner: 'api', apiWindowExpiresAt: expiresAt },
      reason: 'inbound reply received',
    },
    db,
  );
  recordEvent(
    {
      type: 'channel.handoff_to_api',
      funnel: lead.funnel,
      leadId: lead.id,
      conversationId: conversation.id,
      payload: { apiWindowExpiresAt: expiresAt },
    },
    db,
  );

  return {
    conversation: { ...conversation, channelOwner: 'api', apiWindowExpiresAt: expiresAt },
    ownerBefore,
    ownerAfter: 'api',
    apiWindowExpiresAt: expiresAt,
  };
}

/** Closes an expired 24h window so nothing tries to send into it. */
export function expireApiWindow(conversationId: string, db: Db = getDb()): void {
  const conversation = db.select().from(conversations).where(eq(conversations.id, conversationId)).get();
  if (!conversation) return;
  const lead = db.select().from(leads).where(eq(leads.id, conversation.leadId)).get();
  if (!lead) return;
  if (lead.channelState === 'api_eligible' || lead.channelState === 'api_active') {
    transitionChannel({ leadId: lead.id, to: 'api_window_closed', actor: 'system', reason: 'janela de 24h expirada' }, db);
  }
  setConversationOwner(conversationId, 'none', db);
}

export function requireHumanReview(leadId: string, reason: string, db: Db = getDb()): void {
  const conversation = findConversationByLead(leadId, db);
  transitionChannel({ leadId, to: 'human_review_required', actor: 'system', reason }, db);
  if (conversation) setConversationStatus(conversation.id, 'human_review', reason, db);
}
