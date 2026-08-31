import { and, eq, isNotNull, lte } from 'drizzle-orm';
import { z } from 'zod';
import { getDb, type Db } from '@/db/client';
import { conversations, leads, webhookEvents, type JobRow } from '@/db/schema';
import { AppError } from '@/lib/errors';
import { getEnv, operatingHours } from '@/lib/env';
import { isCapabilityUsable } from '@/features/system/capabilities';
import { idempotencyKey } from '@/lib/ids';
import { addHours, nextOperatingSlot } from '@/lib/time';
import { createLogger } from '@/lib/logger';
import { raiseAlert, recordEvent } from '@/lib/audit';
import { getLead, listLeads, qualifyLead, setNextAction } from '@/features/leads/repository';
import { runDiscovery, defaultDiscoverySource, discoveryKeywords } from '@/features/leads/discovery';
import { sendFirstContact } from '@/features/campaigns/first-contact';
import { effectiveDailyCap, evaluatePacing, lastBrowserDmAt, scheduleNextDm } from '@/features/campaigns/guardrails';
import { expireApiWindow, requireHumanReview } from '@/features/conversations/channel';
import { deliverApiReply, processInboundMessage, type ApiSender } from '@/features/conversations/inbound';
import { conversationWithLead, lastOutboundMessage } from '@/features/conversations/repository';
import { optimizeExperiments } from '@/features/experiments/optimizer';
import { learnDiscoveryRanking, learnIcpKeywordWeights } from '@/features/experiments/keyword-learning';
import { anonymizeExpiredLeads } from '@/features/privacy/retention';
import { probeWebhookReachability } from '@/features/system/webhook-reachability';
import { createBackup, pruneBackups } from '@/db/backup';
import { InstagramBrowserDriver } from '@/integrations/browser/instagram-dm';
import type { DmDriver } from '@/integrations/browser/types';
import { extractInboundMessages, markWebhookProcessed, webhookPayloadSchema } from '@/integrations/instagram/webhook';
import { countActiveJobs, enqueue, type JobType } from './queue';

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
  // The send is not scheduled here on purpose - see `dispatchOutreachHandler`.
  // The lead simply waits in `qualified`, and the dispatcher picks it up when
  // there is actually room to contact someone.
  return `Lead qualificado (score ${result.score}); aguardando vaga de envio.`;
};

/**
 * Releases outreach, one lead at a time, only when the pacing rules actually
 * allow a send.
 *
 * The queue used to work the other way round: qualification enqueued a
 * `send_first_dm` per lead the moment it scored well. That cannot scale past
 * the daily cap. `scheduleNextDm` counts forward from *now*, so thirty leads
 * qualified in the same minute all got a send scheduled for roughly the same
 * instant; the first went out and the other twenty-nine woke to a pacing
 * refusal, spent their attempts on it, dead-lettered, and were pushed to human
 * review - manufacturing dead leads in direct proportion to how well discovery
 * worked.
 *
 * Pulling inverts that. Supply (discovery, qualification) and delivery are
 * decoupled: qualified leads accumulate harmlessly, and this job converts
 * exactly one of them into a send whenever the cap and the interval permit.
 * Ordering is by priority then ICP score, so the best lead in the backlog goes
 * first rather than whoever happened to qualify earliest.
 */
const dispatchOutreachHandler: JobHandler = async ({ db, now }) => {
  // Checked here rather than by the runtime's capability gate: this job must
  // always run to completion. It is a poll, re-enqueued every couple of
  // minutes, so deferring it would pile up ticks that never finish.
  if (!isCapabilityUsable('browser_outreach', db)) {
    return 'Envio por navegador indisponível; nada liberado.';
  }

  const pacing = evaluatePacing(now, db);
  if (!pacing.allowed) {
    return `Sem vaga de envio: ${pacing.reason ?? 'ritmo'} (${pacing.sentToday}/${pacing.cap} hoje).`;
  }

  // One send in flight at a time. Two would race the same interval and the
  // loser would burn attempts on a refusal - the very thing this replaces.
  const inFlight = countActiveJobs('send_first_dm', db);
  if (inFlight > 0) return `Já há ${inFlight} primeiro contato em andamento.`;

  const candidate = listLeads(
    { stages: ['qualified'], channelStates: ['browser_contact_pending'], limit: 25 },
    db,
  ).find((lead) => lead.doNotContact === 0);

  if (!candidate) return 'Nenhum lead qualificado aguardando primeiro contato.';

  // Anchor the gap on the previous DM rather than on this tick, so sends stay
  // irregularly spaced the way a person types them. Anchoring on `now` would
  // line every send up with the dispatcher's own cadence, which is the kind of
  // metronomic pattern the pacing rules exist to avoid. With no previous DM
  // there is nothing to space away from, so the first one goes out at once -
  // delaying it would only stall the day's first contact.
  const previous = lastBrowserDmAt(db);
  const desired = previous ? scheduleNextDm(previous) : now;
  const sendAt = desired.getTime() > now.getTime() ? desired : now;

  const queued = enqueue(
    {
      type: 'send_first_dm',
      payload: { leadId: candidate.id },
      leadId: candidate.id,
      scheduledAt: sendAt,
      idempotencyKey: idempotencyKey('send_first_dm', candidate.id),
      priority: candidate.priority,
      maxAttempts: 4,
    },
    db,
  );
  if (queued.duplicate) return `@${candidate.handle} já possui um primeiro contato registrado.`;

  const remaining = pacing.cap - pacing.sentToday;
  return `Primeiro contato liberado para @${candidate.handle} (${remaining} de ${pacing.cap} restantes hoje).`;
};

const sendFirstDmHandler: JobHandler = async ({ job, dmDriver, now }) => {
  const { leadId } = payloadOf(job, leadPayload);
  const result = await sendFirstContact({ leadId, mode: 'live', driver: dmDriver, jobId: job.id, now });

  if (result.status === 'skipped_pacing' && result.retryAt) {
    // Never attempted, so this must not cost the job an attempt.
    throw new AppError('rate_limit_exceeded', result.detail ?? 'Ritmo de envio ainda não permite.', {
      deferral: true,
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

/** Qualified leads waiting for a first contact right now. */
function outreachBacklog(db: Db): number {
  return listLeads({ stages: ['qualified'], channelStates: ['browser_contact_pending'], limit: 500 }, db).filter(
    (lead) => lead.doNotContact === 0,
  ).length;
}

/**
 * Days of backlog to keep in hand. Enough that delivery never idles waiting for
 * supply; small enough that we are not visiting hundreds of profiles to build a
 * queue the daily cap will take a month to work through.
 */
const BACKLOG_TARGET_DAYS = 3;

const discoverLeadsHandler: JobHandler = async ({ job, db, now }) => {
  const payload = payloadOf(job, discoverPayload);

  // Discovery is the expensive, most visible half of this system: every keyword
  // means real page views on Instagram. Sizing it to the backlog keeps supply
  // tied to what delivery can actually consume.
  const backlog = outreachBacklog(db);
  const target = effectiveDailyCap(now, db) * BACKLOG_TARGET_DAYS;
  if (backlog >= target) {
    return `Descoberta adiada: ${backlog} leads qualificados já aguardando (alvo ${target}).`;
  }

  const source = defaultDiscoverySource(db);
  if (!source) {
    throw new AppError('capability_disabled', 'Nenhuma fonte de descoberta automática disponível.', {
      details: { hint: 'configure CHROME_CDP_URL ou importe leads manualmente pelo painel' },
    });
  }

  // Search only as wide as the deficit. A fixed limit per keyword scales with
  // the keyword list instead of with demand: ten keywords at eight results is
  // eighty profile visits to fill a backlog of fifteen. Deriving it from what
  // is actually missing keeps the footprint proportional, and it grows on its
  // own as the warm-up raises the daily cap.
  const keywords = payload.keywords ?? discoveryKeywords(payload.funnel, db);
  const deficit = Math.max(0, target - backlog);
  const perKeyword =
    payload.limitPerKeyword ?? Math.min(10, Math.max(1, Math.ceil(deficit / Math.max(1, keywords.length))));

  const result = await runDiscovery(
    {
      funnel: payload.funnel,
      source,
      keywords,
      limitPerKeyword: perKeyword,
    },
    db,
  );
  return `Descoberta (${perKeyword}/palavra, déficit ${deficit}): ${result.created} novos, ${result.duplicates} duplicados, ${result.suppressed} suprimidos.`;
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

/**
 * One optimisation pass: the message experiments, then the two keyword loops.
 *
 * Keyword learning reads the whole lead history rather than one experiment, so
 * it is orchestrated here instead of inside `optimizeExperiments` - mixing it
 * into that function's per-experiment results would give the two very different
 * things the same shape.
 */
const optimizeHandler: JobHandler = async ({ db }) => {
  const outcomes = optimizeExperiments(db);
  const changed = outcomes.filter((outcome) => outcome.action !== 'unchanged');

  const learning = [learnDiscoveryRanking(db), learnIcpKeywordWeights(db)];
  for (const outcome of learning) log.info('keyword learning', { action: outcome.action, detail: outcome.detail });
  const learned = learning.filter((outcome) => outcome.action === 'written');

  return `Otimização: ${outcomes.length} experimentos avaliados, ${changed.length} ajustados; aprendizado de palavras-chave: ${learned.length} de ${learning.length} atualizados. ${learning.map((entry) => entry.detail).join(' ')}`;
};

export const HANDLERS: Record<JobType, JobHandler> = {
  qualify_lead: qualifyLeadHandler,
  dispatch_outreach: dispatchOutreachHandler,
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
  // The outreach dispatcher. Frequent and cheap: it reads the pacing state and
  // usually decides to do nothing. This is the job that turns qualified leads
  // into sends, so if it stops running, outreach stops entirely.
  enqueue(
    {
      type: 'dispatch_outreach',
      scheduledAt: now,
      idempotencyKey: idempotencyKey('dispatch_outreach', twoMinuteBucket(now)),
      // A poll, not a task: a failed tick is replaced by the next one, and
      // dead-lettering it would open an alert every two minutes.
      maxAttempts: 1,
    },
    db,
  );
  // Discovery, once a day, self-limited by the backlog it already built. This
  // is the first link of the chain discover -> qualify -> dispatch -> send;
  // without it nothing new ever enters the funnel.
  enqueue(
    {
      type: 'discover_leads',
      payload: { funnel: 'customer' },
      scheduledAt: nextOperatingSlot(now, operatingHours(), getEnv().OPERATING_TIMEZONE),
      idempotencyKey: idempotencyKey('discover_leads', day),
      maxAttempts: 2,
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

/** Bucket key that changes every two minutes, for the outreach dispatcher. */
function twoMinuteBucket(now: Date): string {
  return String(Math.floor(now.getTime() / 120_000));
}

/** Bucket key that changes every five minutes, so repeated scheduling is idempotent within the window. */
function fiveMinuteBucket(now: Date): string {
  const slot = Math.floor(now.getTime() / 300_000);
  return String(slot);
}
