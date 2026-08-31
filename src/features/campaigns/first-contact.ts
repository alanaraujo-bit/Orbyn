import { eq } from 'drizzle-orm';
import { getDb, transact, type Db } from '@/db/client';
import { leads } from '@/db/schema';
import { AppError, isAppError } from '@/lib/errors';
import { idempotencyKey } from '@/lib/ids';
import { browserMutex } from '@/lib/mutex';
import { createLogger } from '@/lib/logger';
import { raiseAlert, recordEvent } from '@/lib/audit';
import { getBusinessConfig } from '@/config/business';
import { pauseCapability, requireUsableCapability } from '@/features/system/capabilities';
import { recordBreakerFailure, recordBreakerSuccess, assertBreakerClosed } from '@/lib/circuit-breaker';
import { closeLead, getLead, transitionStage } from '@/features/leads/repository';
import { isSuppressed } from '@/features/leads/suppression';
import type { Funnel } from '@/features/leads/states';
import { assertCanSend, claimBrowserChannel, markBrowserContactSent } from '@/features/conversations/channel';
import { recordOutboundMessage } from '@/features/conversations/messages';
import { generateOpener, MessagePolicyError } from '@/features/conversations/engine';
import { assignVariant, DEFAULT_OPENER_GUIDANCE } from '@/features/experiments/assignment';
import type { DmDriver, DmEvidence, DmMode, SendDmResult } from '@/integrations/browser/types';
import { evaluatePacing, incrementDmCounter } from './guardrails';

const log = createLogger('first-contact');

/** Discovery source reserved for the panel demo dataset. */
export const DEMO_DISCOVERY_SOURCE = 'demo_seed';

/**
 * First contact over the browser. This is the one place where a message can
 * leave the system through the browser channel, and it enforces, in order:
 * capability, suppression, pacing, channel ownership, content policy and
 * idempotency.
 */

export type FirstContactStatus =
  | 'sent'
  | 'dry_run_ok'
  | 'already_sent'
  | 'skipped_pacing'
  | 'skipped_suppressed'
  | 'profile_not_found'
  | 'messaging_unavailable'
  | 'safety_paused'
  | 'policy_blocked';

export interface FirstContactInput {
  leadId: string;
  mode: DmMode;
  driver: DmDriver;
  jobId: string;
  now?: Date;
}

export interface FirstContactResult {
  status: FirstContactStatus;
  message?: string;
  detail?: string;
  retryAt?: Date;
  /** Artefacts captured by the driver, when it produced any. */
  evidence?: DmEvidence;
}

export function firstDmIdempotencyKey(leadId: string): string {
  return idempotencyKey('first_dm', leadId);
}

export async function sendFirstContact(input: FirstContactInput): Promise<FirstContactResult> {
  const db = getDb();
  const now = input.now ?? new Date();
  const lead = getLead(input.leadId, db);
  const funnel = lead.funnel as Funnel;
  const config = getBusinessConfig();

  requireUsableCapability(funnel === 'customer' ? 'customer_funnel' : 'affiliate_funnel', db);
  // Only a live send needs the real browser capability. A dry run still goes
  // through the driver, which fails loudly on its own if Chrome is missing.
  if (input.mode === 'live') {
    requireUsableCapability('browser_outreach', db);
    assertBreakerClosed('browser', db);
  }

  if (lead.doNotContact === 1 || isSuppressed(lead.handle, lead.platform, db)) {
    return { status: 'skipped_suppressed', detail: 'Lead em lista de não contato.' };
  }

  // Demo records exist only to populate the panel; they may never be contacted.
  if (lead.discoverySource === DEMO_DISCOVERY_SOURCE && input.mode === 'live') {
    return { status: 'skipped_suppressed', detail: 'Lead de demonstração nunca recebe contato real.' };
  }

  if (input.mode !== 'dry_run') {
    const pacing = evaluatePacing(now, db);
    if (!pacing.allowed) {
      return { status: 'skipped_pacing', detail: pacing.reason, retryAt: pacing.retryAt };
    }
  }

  const conversation = claimBrowserChannel(lead.id, db);
  assertCanSend({ lead, conversation, channel: 'browser', now }, db);

  const key = firstDmIdempotencyKey(lead.id);
  const variant = assignVariant(lead.id, funnel, 'opener', db);

  let opener;
  try {
    opener = await generateOpener({
      lead,
      variantGuidance: variant?.guidance ?? DEFAULT_OPENER_GUIDANCE,
      config,
      jobId: input.jobId,
    });
  } catch (error) {
    if (error instanceof MessagePolicyError) {
      raiseAlert(
        {
          kind: 'exception',
          severity: 'warning',
          code: 'opener_policy_blocked',
          title: 'Abertura reprovada pela política de conteúdo',
          detail: error.message,
          context: { violations: error.violations },
          leadId: lead.id,
          jobId: input.jobId,
        },
        db,
      );
      return { status: 'policy_blocked', detail: error.message };
    }
    throw error;
  }

  let send: SendDmResult;
  try {
    send = await browserMutex.runExclusive(() =>
      input.driver.sendDirectMessage({ handle: lead.handle, text: opener.message, mode: input.mode, jobId: input.jobId }),
    );
  } catch (error) {
    if (isAppError(error) && error.code === 'account_safety_signal') {
      pauseCapability(
        {
          capability: 'browser_outreach',
          reason: `Sinal de segurança do Instagram: ${String(error.details.signal ?? 'desconhecido')}.`,
          by: 'system',
          details: error.details,
          alert: { severity: 'critical', code: 'account_safety_signal', title: 'Automação pausada por sinal de segurança' },
        },
        db,
      );
      recordEvent({ type: 'browser.safety_signal', funnel, leadId: lead.id, payload: error.details }, db);
      return { status: 'safety_paused', detail: error.message };
    }
    if (isAppError(error) && error.code === 'browser_unavailable') {
      const state = recordBreakerFailure('browser', error.message, db);
      raiseAlert(
        {
          kind: 'integration',
          severity: 'warning',
          code: 'browser_unavailable',
          title: 'Chrome do operador indisponível',
          detail: error.message,
          context: { breaker: state },
          dedupeKey: 'integration:browser_unavailable',
        },
        db,
      );
    }
    throw error;
  }

  if (send.status === 'dry_run_ok') {
    recordEvent(
      { type: 'outreach.dry_run', funnel, leadId: lead.id, payload: { chars: opener.message.length, generator: opener.generator } },
      db,
    );
    return { status: 'dry_run_ok', message: opener.message, detail: send.message, evidence: send.evidence };
  }

  if (send.status === 'profile_not_found') {
    closeLead(lead.id, 'perfil não encontrado', 'worker', db);
    return { status: 'profile_not_found', detail: 'Perfil não encontrado no Instagram.' };
  }

  if (send.status === 'messaging_unavailable' || send.status === 'failed') {
    // In a dry run this is a finding, not an incident: report it to the operator
    // without tripping the breaker or opening an alert.
    if (input.mode === 'dry_run') {
      return {
        status: 'messaging_unavailable',
        detail: send.message ?? send.status,
        evidence: send.evidence,
      };
    }
    const state = recordBreakerFailure('browser', send.message ?? send.status, db);
    raiseAlert(
      {
        kind: 'exception',
        severity: 'warning',
        code: 'browser_action_failed',
        title: 'Falha ao enviar primeira DM',
        detail: send.message ?? send.status,
        context: { evidence: send.evidence, breaker: state },
        leadId: lead.id,
        jobId: input.jobId,
      },
      db,
    );
    throw new AppError('browser_action_failed', send.message ?? 'Falha ao enviar a primeira DM.', {
      details: { status: send.status, evidence: send.evidence },
      retryable: true,
    });
  }

  recordBreakerSuccess('browser', db);

  // The message has physically left. From here on, losing the record is worse
  // than any bookkeeping error: without it a retry would deliver a SECOND real
  // message to a real person. So persistence of the send is committed on its
  // own, and everything after it is best-effort.
  const outbound = transact((tx: Db) =>
    recordOutboundMessage(
      {
        conversationId: conversation.id,
        leadId: lead.id,
        channel: 'browser',
        body: opener.message,
        idempotencyKey: key,
        experimentId: variant?.experimentId ?? null,
        variantId: variant?.variantId ?? null,
        jobId: input.jobId,
        sentAt: send.sentAt,
        meta: {
          generator: opener.generator,
          observationUsed: opener.observationUsed,
          variant: variant?.variantName ?? null,
          evidenceUrl: send.evidence.url ?? null,
        },
      },
      tx,
    ),
  );

  if (outbound.duplicate) {
    log.warn('duplicate first DM suppressed', { leadId: lead.id });
    return { status: 'already_sent', message: outbound.message.body };
  }

  // Pacing must also survive: an uncounted send would let the daily cap drift.
  transact((tx: Db) => incrementDmCounter(now, tx));

  // State bookkeeping. A failure here is reported, never allowed to undo the
  // durable record above.
  try {
    transact((tx: Db) => {
      markBrowserContactSent(lead.id, tx);
      tx.update(leads).set({ nextActionAt: null, nextActionKind: 'aguardando_resposta' }).where(eq(leads.id, lead.id)).run();
      recordEvent(
        {
          type: 'outreach.first_dm_sent',
          funnel,
          leadId: lead.id,
          conversationId: conversation.id,
          experimentId: variant?.experimentId ?? null,
          variantId: variant?.variantId ?? null,
          payload: { generator: opener.generator, chars: opener.message.length },
        },
        tx,
      );
    });
  } catch (error) {
    reportPostSendFailure(lead.id, input.jobId, 'canal', error, db);
  }

  // The commercial stage may legitimately refuse to advance - a lead closed by
  // qualification, for instance. That is not a reason to lose the send.
  try {
    transitionStage({ leadId: lead.id, to: 'contacted', actor: 'worker', reason: 'primeira DM enviada' }, db);
  } catch (error) {
    reportPostSendFailure(lead.id, input.jobId, 'etapa', error, db);
  }

  return { status: 'sent', message: opener.message };
}

/** A send already happened; the operator has to know the records lagged it. */
function reportPostSendFailure(
  leadId: string,
  jobId: string,
  what: string,
  error: unknown,
  db: Db,
): void {
  const message = error instanceof Error ? error.message : String(error);
  log.error('post-send bookkeeping failed', { leadId, what, error: message });
  raiseAlert(
    {
      kind: 'data_integrity',
      severity: 'warning',
      code: 'post_send_state_mismatch',
      title: 'DM enviada, mas o estado do lead não acompanhou',
      detail: `A mensagem foi entregue e registrada, porém a atualização de ${what} falhou: ${message}`,
      context: { leadId, what },
      leadId,
      jobId,
      dedupeKey: `post_send:${leadId}:${what}`,
    },
    db,
  );
}
