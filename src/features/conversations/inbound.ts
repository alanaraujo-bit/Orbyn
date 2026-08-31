import { eq } from 'drizzle-orm';
import { getDb, type Db } from '@/db/client';
import { leads } from '@/db/schema';
import { AppError, isAppError } from '@/lib/errors';
import { idempotencyKey } from '@/lib/ids';
import { addHours, nowIso } from '@/lib/time';
import { raiseAlert, recordEvent } from '@/lib/audit';
import { createLogger } from '@/lib/logger';
import { getBusinessConfig, outboundLink } from '@/config/business';
import { isCapabilityUsable } from '@/features/system/capabilities';
import { applyDoNotContact, closeLead, getLead, setNextAction, transitionStage } from '@/features/leads/repository';
import { findLeadByHandle, findLeadByPlatformUserId } from '@/features/leads/repository';
import { normalizeHandle } from '@/features/leads/handle';
import type { Funnel, PipelineStage } from '@/features/leads/states';
import { cancelJobsForLead, enqueue } from '@/worker/queue';
import { fetchUsername, sendApiMessage, type SendApiMessageInput, type SendApiMessageResult } from '@/integrations/instagram/client';
import type { InboundMessageEvent } from '@/integrations/instagram/webhook';
import { assertCanSend, handoffToApi, requireHumanReview } from './channel';
import { conversationWithLead, findConversationByLead, listMessages, setConversationStatus } from './repository';
import { confirmDelivery, isUnconfirmed, recordInboundMessage, recordOutboundMessage, setMessageIntent } from './messages';
import { interpretInbound, MessagePolicyError, planReply } from './engine';
import { validateOutboundText } from './message-policy';
import type { Intent, NextAction } from './intents';

const log = createLogger('inbound');

/**
 * Inbound pipeline: webhook event -> lead -> handoff -> interpretation ->
 * next action. Prospecting threads are the only ones this touches; a message
 * from someone who is not a known lead is reported to the operator and left
 * alone, so personal conversations stay out of the funnel.
 */

export type InboundOutcome =
  | { status: 'processed'; leadId: string; intent: Intent; action: NextAction }
  | { status: 'duplicate'; leadId: string }
  | { status: 'unmatched_sender'; senderId: string }
  | { status: 'opted_out'; leadId: string }
  | { status: 'ignored'; reason: string };

export async function resolveLeadIdForSender(senderId: string, db: Db = getDb()): Promise<string | null> {
  const byId = findLeadByPlatformUserId(senderId, db);
  if (byId) return byId.id;

  if (!isCapabilityUsable('api_messaging', db)) return null;

  const username = await fetchUsername(senderId);
  if (!username) return null;

  let normalized: string;
  try {
    normalized = normalizeHandle(username);
  } catch {
    return null;
  }

  const lead = findLeadByHandle(normalized, db);
  if (!lead) return null;

  db.update(leads).set({ platformUserId: senderId, updatedAt: nowIso() }).where(eq(leads.id, lead.id)).run();
  return lead.id;
}

function advanceStageOnReply(leadId: string, db: Db): void {
  const lead = getLead(leadId, db);
  if (lead.pipelineStage === 'contacted') {
    transitionStage({ leadId, to: 'replied', actor: 'webhook', reason: 'lead respondeu' }, db);
  }
}

/** Outbound transport for API replies; injectable so tests never hit Meta. */
export type ApiSender = (input: SendApiMessageInput) => Promise<SendApiMessageResult>;

export interface ProcessInboundInput {
  event: InboundMessageEvent;
  jobId: string;
  sender?: ApiSender;
}

export async function processInboundMessage(input: ProcessInboundInput): Promise<InboundOutcome> {
  const db = getDb();
  const { event } = input;

  const leadId = await resolveLeadIdForSender(event.senderId, db);
  if (!leadId) {
    raiseAlert(
      {
        kind: 'exception',
        severity: 'info',
        code: 'unmatched_inbound_sender',
        title: 'Mensagem recebida de remetente fora da prospecção',
        detail: 'A mensagem não pertence a nenhum lead conhecido e foi ignorada pelo funil.',
        context: { senderId: event.senderId },
        dedupeKey: `unmatched:${event.senderId}`,
      },
      db,
    );
    return { status: 'unmatched_sender', senderId: event.senderId };
  }

  const handoff = handoffToApi({ leadId, receivedAt: event.receivedAt, platformUserId: event.senderId }, db);
  const inbound = recordInboundMessage(
    {
      conversationId: handoff.conversation.id,
      leadId,
      body: event.text,
      externalMessageId: event.externalId,
      receivedAt: event.receivedAt,
      meta: { senderId: event.senderId },
    },
    db,
  );
  if (inbound.duplicate) return { status: 'duplicate', leadId };

  advanceStageOnReply(leadId, db);

  const lead = getLead(leadId, db);
  const interpretation = await interpretInbound(lead, event.text, input.jobId);
  setMessageIntent(inbound.message.id, interpretation.intent, db);
  recordEvent(
    {
      type: 'inbound.interpreted',
      funnel: lead.funnel,
      leadId,
      conversationId: handoff.conversation.id,
      payload: { intent: interpretation.intent, generator: interpretation.generator, confidence: interpretation.confidence },
    },
    db,
  );

  if (interpretation.intent === 'opt_out') {
    applyDoNotContact({ leadId, reason: 'opt_out', source: 'inbound_message', actor: 'webhook' }, db);
    cancelJobsForLead(leadId, 'opt-out solicitado pelo lead', db);
    closeLead(leadId, 'opt-out', 'webhook', db);
    setConversationStatus(handoff.conversation.id, 'closed', null, db);
    return { status: 'opted_out', leadId };
  }

  const history = listMessages(handoff.conversation.id, db);
  let plan;
  try {
    plan = await planReply({
      lead,
      intent: interpretation.intent,
      history,
      conversationId: handoff.conversation.id,
      jobId: input.jobId,
    });
  } catch (error) {
    if (error instanceof MessagePolicyError) {
      requireHumanReview(leadId, `Resposta reprovada pela política: ${error.message}`, db);
      raiseAlert(
        {
          kind: 'exception',
          severity: 'warning',
          code: 'reply_policy_blocked',
          title: 'Resposta reprovada pela política de conteúdo',
          detail: error.message,
          context: { violations: error.violations },
          leadId,
        },
        db,
      );
      return { status: 'processed', leadId, intent: interpretation.intent, action: 'escalate_to_human' };
    }
    throw error;
  }

  await executePlan(
    { leadId, conversationId: handoff.conversation.id, plan, jobId: input.jobId, sender: input.sender },
    db,
  );
  return { status: 'processed', leadId, intent: interpretation.intent, action: plan.action };
}

interface ExecutePlanInput {
  leadId: string;
  conversationId: string;
  plan: { action: NextAction; message: string | null; reason: string };
  jobId: string;
  sender?: ApiSender;
}

async function executePlan(input: ExecutePlanInput, db: Db): Promise<void> {
  const { plan } = input;
  const config = getBusinessConfig();

  if (plan.action === 'escalate_to_human') {
    requireHumanReview(input.leadId, plan.reason, db);
    raiseAlert(
      {
        kind: 'exception',
        severity: 'info',
        code: 'human_review_required',
        title: 'Conversa aguardando decisão humana',
        detail: plan.reason,
        leadId: input.leadId,
      },
      db,
    );
    return;
  }

  if (plan.action === 'close') {
    closeLead(input.leadId, plan.reason, 'ai', db);
    setConversationStatus(input.conversationId, 'closed', null, db);
    return;
  }

  if (plan.action === 'wait') {
    setNextAction(input.leadId, addHours(new Date(), 48).toISOString(), 'followup', db);
    enqueue(
      {
        type: 'followup',
        payload: { leadId: input.leadId },
        leadId: input.leadId,
        scheduledAt: addHours(new Date(), 48),
        idempotencyKey: idempotencyKey('followup', input.leadId, new Date().toISOString().slice(0, 10)),
      },
      db,
    );
    return;
  }

  if (plan.action === 'schedule_followup') {
    setNextAction(input.leadId, addHours(new Date(), 24).toISOString(), 'followup', db);
    return;
  }

  let text = plan.message;
  if (plan.action === 'send_whatsapp') {
    const link = outboundLink('whatsapp', config);
    if (!link) {
      requireHumanReview(input.leadId, 'Link de WhatsApp não configurado.', db);
      return;
    }
    if (!text || !text.includes(link)) {
      text = `${text ? `${text.trim()} ` : ''}Consigo te explicar melhor por aqui: ${link}`;
    }
  }

  if (!text || text.trim().length === 0) {
    requireHumanReview(input.leadId, 'A IA não produziu mensagem para a ação escolhida.', db);
    return;
  }

  await deliverApiReply(
    { leadId: input.leadId, conversationId: input.conversationId, text, jobId: input.jobId, sender: input.sender },
    db,
  );

  if (plan.action === 'send_whatsapp') {
    const current = getLead(input.leadId, db);
    const target: PipelineStage = current.funnel === 'customer' ? 'whatsapp_handoff' : 'joined_affiliate_group';
    const path: PipelineStage[] = ['replied', 'interested', target];
    for (const stage of path) {
      const now = getLead(input.leadId, db);
      if (now.pipelineStage === stage) continue;
      try {
        transitionStage({ leadId: input.leadId, to: stage, actor: 'ai', reason: 'encaminhado ao canal seguinte' }, db);
      } catch (error) {
        if (!isAppError(error) || error.code !== 'invalid_state_transition') throw error;
      }
    }
  }
}

export interface DeliverApiReplyInput {
  leadId: string;
  conversationId: string;
  text: string;
  jobId: string;
  sender?: ApiSender;
}

/**
 * The only path that sends through the official API. Ownership, window,
 * eligibility, suppression and content policy are all checked before the
 * request leaves, and the send is recorded idempotently.
 */
export async function deliverApiReply(input: DeliverApiReplyInput, db: Db = getDb()): Promise<void> {
  const { conversation, lead } = conversationWithLead(input.conversationId, db);

  const policy = validateOutboundText(input.text);
  if (!policy.ok) throw new MessagePolicyError(policy.violations);

  assertCanSend({ lead, conversation, channel: 'api' }, db);

  const key = idempotencyKey('api_reply', input.leadId, input.text);
  const attempt = recordOutboundMessage(
    {
      conversationId: input.conversationId,
      leadId: input.leadId,
      channel: 'api',
      body: input.text,
      idempotencyKey: key,
      jobId: input.jobId,
      meta: { pending: true },
    },
    db,
  );

  // The row is written before the request, so a crash between the two cannot
  // produce a second delivery. That means an existing row only proves an
  // *attempt*; delivery is proven by the provider's message id. A row without
  // one is retried, otherwise a transient failure would silently swallow the
  // reply and the CRM would show a message the lead never received.
  if (attempt.duplicate && !isUnconfirmed(attempt.message)) {
    log.warn('api reply already delivered, skipping', { leadId: input.leadId });
    return;
  }
  if (attempt.duplicate) {
    log.info('retrying an unconfirmed api reply', { leadId: input.leadId, messageId: attempt.message.id });
  }

  if (!lead.platformUserId) {
    throw new AppError('api_ineligible_recipient', 'Lead sem platformUserId para envio via API.');
  }

  const send = input.sender ?? sendApiMessage;
  const result = await send({ recipientId: lead.platformUserId, text: input.text });
  confirmDelivery(attempt.message.id, result.messageId, db);
  db.update(leads).set({ lastOutboundAt: nowIso(), updatedAt: nowIso() }).where(eq(leads.id, input.leadId)).run();
  recordEvent(
    {
      type: 'outreach.api_reply_sent',
      funnel: lead.funnel as Funnel,
      leadId: input.leadId,
      conversationId: input.conversationId,
      payload: { externalMessageId: result.messageId },
    },
    db,
  );
}

export function conversationForLead(leadId: string, db: Db = getDb()) {
  return findConversationByLead(leadId, db);
}
