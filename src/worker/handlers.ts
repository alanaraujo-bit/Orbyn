import { and, eq, isNotNull, lte } from 'drizzle-orm';
import { z } from 'zod';
import { getDb, type Db } from '@/db/client';
import { conversations, leads, webhookEvents, type JobRow } from '@/db/schema';
import { AppError } from '@/lib/errors';
import { idempotencyKey } from '@/lib/ids';
import { addHours } from '@/lib/time';
import { createLogger } from '@/lib/logger';
import { raiseAlert, recordEvent } from '@/lib/audit';
import { getLead, qualifyLead, setNextAction } from '@/features/leads/repository';
import { runDiscovery, defaultDiscoverySource } from '@/features/leads/discovery';
import { sendFirstContact } from '@/features/campaigns/first-contact';
import { scheduleNextDm } from '@/features/campaigns/guardrails';
import { expireApiWindow, requireHumanReview } from '@/features/conversations/channel';
import { deliverApiReply, processInboundMessage, type ApiSender } from '@/features/conversations/inbound';
import { conversationWithLead, lastOutboundMessage } from '@/features/conversations/repository';
import { optimizeExperiments } from '@/features/experiments/optimizer';
import { anonymizeExpiredLeads } from '@/features/privacy/retention';
import { probeWebhookReachability } from '@/features/system/webhook-reachability';
import { createBackup, pruneBackups } from '@/db/backup';
import { InstagramBrowserDriver } from '@/integrations/browser/instagram-dm';
import type { DmDriver } from '@/integrations/browser/types';
import { extractInboundMessages, markWebhookProcessed, webhookPayloadSchema } from '@/integrations/instagram/webhook';
import { enqueue, type JobType } from './queue';

const log = createLogger('worker.handlers');

/**
 * Job handlers. Each one is idempotent, validates its own payload, and either
 * completes or throws a typed error the runtime knows how to retry.
 */

export interface HandlerContext {
  job: JobRow;
  db: Db;
  /** Injectable so tests and the dry-run CLI can drive a simulated browser. */
  dmDriver: DmDriver;
  /** Injectable transport for API replies; defaults to the real Graph client. */
  apiSender?: ApiSender;
  now: Date;
}

export type JobHandler = (context: HandlerContext) => Promise<string>;

function payloadOf<T>(job: JobRow, schema: z.ZodType<T>): T {
  const parsed = schema.safeParse(JSON.parse(job.payload));
  if (!parsed.success) {
    throw new AppError('validation_failed', `Payload inválido para o job ${job.type}.`, {
      details: { issues: parsed.error.issues.map((issue) => issue.message) },
    });
  }
  return parsed.data;
}

const leadPayload = z.object({ leadId: z.string().min(1) });
const discoverPayload = z.object({
  funnel: z.enum(['customer', 'affiliate']).default('customer'),
  limitPerKeyword: z.number().int().positive().max(50).optional(),
  keywords: z.array(z.string()).optional(),
});
const inboundPayload = z.object({ webhookEventId: z.string().min(1) });

const qualifyLeadHandler: JobHandler = async ({ job, db }) => {
  const { leadId } = payloadOf(job, leadPayload);
  const result = qualifyLead(leadId, db);
  if (!result.qualified) return `Lead fora do ICP (score ${result.score}); encerrado.`;

  enqueue(
    {
      type: 'send_first_dm',
      payload: { leadId },
      leadId,
      scheduledAt: scheduleNextDm(new Date()),
      idempotencyKey: idempotencyKey('send_first_dm', leadId),
      priority: result.lead.priority,
      maxAttempts: 4,
    },
    db,
  );
  return `Lead qualificado (score ${result.score}); primeiro contato agendado.`;
};

const sendFirstDmHandler: JobHandler = async ({ job, dmDriver, now }) => {
  const { leadId } = payloadOf(job, leadPayload);
  const result = await sendFirstContact({ leadId, mode: 'live', driver: dmDriver, jobId: job.id, now });

  if (result.status === 'skipped_pacing' && result.retryAt) {
    throw new AppError('rate_limit_exceeded', result.detail ?? 'Ritmo de envio ainda não permite.', {
      retryable: true,
      details: { retryAt: result.retryAt.toISOString() },
    });
  }
  if (result.status === 'safety_paused') {
    return 'Automação pausada por sinal de segurança do Instagram.';
  }
  return `Primeiro contato: ${result.status}.`;
};

const processInboundHandler: JobHandler = async ({ job, db, apiSender }) => {
  const { webhookEventId } = payloadOf(job, inboundPayload);
  const stored = db.select().from(webhookEvents).where(eq(webhookEvents.id, webhookEventId)).get();
  if (!stored) throw new AppError('not_found', `Evento de webhook ${webhookEventId} não encontrado.`);

  const parsed = webhookPayloadSchema.safeParse(JSON.parse(stored.payload));
  if (!parsed.success) {
    markWebhookProcessed(webhookEventId, 'failed', 'payload fora do schema', db);
    throw new AppError('validation_failed', 'Payload do webhook fora do schema.');
  }

  const messages = extractInboundMessages(parsed.data).filter((entry) => entry.externalId === stored.externalId);
  if (messages.length === 0) {
    markWebhookProcessed(webhookEventId, 'ignored', 'sem mensagem de texto aplicável', db);
    return 'Evento sem mensagem aplicável.';
  }

  const outcomes: string[] = [];
  for (const message of messages) {
    const outcome = await processInboundMessage({ event: message, jobId: job.id, sender: apiSender });
    outcomes.push(outcome.status);
  }
  markWebhookProcessed(webhookEventId, 'processed', null, db);
  return `Inbound processado: ${outcomes.join(', ')}.`;
};

const discoverLeadsHandler: JobHandler = async ({ job, db }) => {
  const payload = payloadOf(job, discoverPayload);
  const source = defaultDiscoverySource(db);
  if (!source) {
    throw new AppError('capability_disabled', 'Nenhuma fonte de descoberta automática disponível.', {
      details: { hint: 'configure CHROME_CDP_URL ou importe leads manualmente pelo painel' },
    });
  }
  const result = await runDiscovery(
    {
      funnel: payload.funnel,
      source,
      keywords: payload.keywords,
      limitPerKeyword: payload.limitPerKeyword ?? 8,
    },
    db,
  );
  return `Descoberta: ${result.created} novos, ${result.duplicates} duplicados, ${result.suppressed} suprimidos.`;
};

const followupHandler: JobHandler = async ({ job, db, now, apiSender }) => {
  const { leadId } = payloadOf(job, leadPayload);
  const lead = getLead(leadId, db);
  if (lead.doNotContact === 1) return 'Lead em não contatar; follow-up cancelado.';

  const conversation = db.select().from(conversations).where(eq(conversations.leadId, leadId)).get();
  if (!conversation) return 'Sem conversa associada.';

  const windowOpen =
    conversation.apiWindowExpiresAt !== null && new Date(conversation.apiWindowExpiresAt).getTime() > now.getTime();

  if (!windowOpen) {
    // Meta does not allow re-opening the thread from our side, and the browser
    // is not allowed back in. The follow-up is simply not possible.
    expireApiWindow(conversation.id, db);
    setNextAction(leadId, null, null, db);
    recordEvent({ type: 'followup.window_closed', funnel: lead.funnel, leadId, payload: {} }, db);
    return 'Janela de 24h encerrada; follow-up não é permitido pela plataforma.';
  }

  const last = lastOutboundMessage(conversation.id, db);
  if (last && now.getTime() - new Date(last.createdAt).getTime() < 6 * 3600_000) {
    return 'Última mensagem ainda recente; follow-up adiado.';
  }

  const { lead: current } = conversationWithLead(conversation.id, db);
  const text = `Oi, ${current.displayName?.split(' ')[0] ?? 'tudo bem'}? Só retomando aqui: quer que eu te explique como funciona o nosso processo?`;
  await deliverApiReply({ leadId, conversationId: conversation.id, text, jobId: job.id, sender: apiSender }, db);
  setNextAction(leadId, null, null, db);
  return 'Follow-up enviado pela API oficial.';
};

const expireWindowsHandler: JobHandler = async ({ db, now }) => {
  const expired = db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(isNotNull(conversations.apiWindowExpiresAt), lte(conversations.apiWindowExpiresAt, now.toISOString())))
    .all();
  for (const conversation of expired) expireApiWindow(conversation.id, db);
  return `Janelas encerradas: ${expired.length}.`;
};

const retentionHandler: JobHandler = async ({ db, now }) => {
  const result = anonymizeExpiredLeads(now, db);
  return `Retenção aplicada: ${result.anonymized} leads anonimizados.`;
};

const backupHandler: JobHandler = async () => {
  const backup = await createBackup();
  const pruned = pruneBackups(14);
  return `Backup criado (${Math.round(backup.bytes / 1024)} KB); ${pruned.length} antigos removidos.`;
};

const optimizeHandler: JobHandler = async ({ db }) => {
  const outcomes = optimizeExperiments(db);
  const changed = outcomes.filter((outcome) => outcome.action !== 'unchanged');
  return `Otimização: ${outcomes.length} experimentos avaliados, ${changed.length} ajustados.`;
};

export const HANDLERS: Record<JobType, JobHandler> = {
  qualify_lead: qualifyLeadHandler,
  send_first_dm: sendFirstDmHandler,
  process_inbound: processInboundHandler,
  discover_leads: discoverLeadsHandler,
  followup: followupHandler,
  expire_api_windows: expireWindowsHandler,
  retention_cleanup: retentionHandler,
  backup_database: backupHandler,
  optimize_strategy: optimizeHandler,
  check_webhook_reachability: async ({ db }) => {
    const result = await probeWebhookReachability({ db });
    if (result.status === 'skipped') return `Verificação ignorada: ${result.reason}`;
    if (result.status === 'reachable') return `URL pública respondendo em ${result.latencyMs}ms.`;
    return `URL pública inacessível: ${result.reason}`;
  },
  send_api_reply: async ({ job, db, apiSender }) => {
    const schema = z.object({ leadId: z.string(), conversationId: z.string(), text: z.string().min(1) });
    const payload = payloadOf(job, schema);
    await deliverApiReply({ ...payload, jobId: job.id, sender: apiSender }, db);
    return 'Resposta enviada pela API oficial.';
  },
};

export function defaultDmDriver(): DmDriver {
  return new InstagramBrowserDriver();
}

/** Escalates a job that exhausted its retries into an operator-visible queue. */
export function reportDeadJob(job: JobRow, error: string, db: Db = getDb()): void {
  raiseAlert(
    {
      kind: 'exception',
      severity: 'warning',
      code: 'job_dead_letter',
      title: `Job ${job.type} esgotou as tentativas`,
      detail: error,
      context: { jobId: job.id, attempts: job.attempts },
      leadId: job.leadId,
      jobId: job.id,
      dedupeKey: `dead:${job.id}`,
    },
    db,
  );
  if (job.leadId) {
    const lead = db.select().from(leads).where(eq(leads.id, job.leadId)).get();
    if (lead && lead.channelState !== 'do_not_contact' && lead.channelState !== 'human_review_required') {
      try {
        requireHumanReview(job.leadId, `Job ${job.type} falhou: ${error.slice(0, 200)}`, db);
      } catch (transitionError) {
        log.warn('could not move lead to human review', {
          leadId: job.leadId,
          error: transitionError instanceof Error ? transitionError.message : String(transitionError),
        });
      }
    }
  }
}

/** Recurring maintenance jobs, scheduled on worker start. */
export function scheduleRecurringJobs(now: Date = new Date(), db: Db = getDb()): void {
  const day = now.toISOString().slice(0, 10);
  const hourBucket = `${day}T${String(now.getUTCHours()).padStart(2, '0')}`;

  enqueue(
    {
      type: 'expire_api_windows',
      scheduledAt: now,
      idempotencyKey: idempotencyKey('expire_api_windows', hourBucket),
    },
    db,
  );
  enqueue(
    { type: 'backup_database', scheduledAt: now, idempotencyKey: idempotencyKey('backup_database', day) },
    db,
  );
  enqueue(
    { type: 'retention_cleanup', scheduledAt: now, idempotencyKey: idempotencyKey('retention_cleanup', day) },
    db,
  );
  enqueue(
    {
      type: 'optimize_strategy',
      scheduledAt: addHours(now, 1),
      idempotencyKey: idempotencyKey('optimize_strategy', day),
    },
    db,
  );
  // Every five minutes, not daily: a dead tunnel costs a lead every hour it goes
  // unnoticed, and the check is one local HTTP round trip.
  enqueue(
    {
      type: 'check_webhook_reachability',
      scheduledAt: now,
      idempotencyKey: idempotencyKey('check_webhook_reachability', fiveMinuteBucket(now)),
      // A transient network blip must not dead-letter the watchdog itself.
      maxAttempts: 1,
    },
    db,
  );
}

/** Bucket key that changes every five minutes, so repeated scheduling is idempotent within the window. */
function fiveMinuteBucket(now: Date): string {
  const slot = Math.floor(now.getTime() / 300_000);
  return String(slot);
}
