import { randomUUID } from 'node:crypto';
import { getDb, type Db } from '@/db/client';
import { AppError, isAppError, toErrorPayload } from '@/lib/errors';
import { createLogger } from '@/lib/logger';
import { sleep } from '@/lib/sleep';
import { recordEvent } from '@/lib/audit';
import { getEnv } from '@/lib/env';
import { isCapabilityUsable } from '@/features/system/capabilities';
import type { DmDriver } from '@/integrations/browser/types';
import type { ApiSender } from '@/features/conversations/inbound';
import { claimNextJob, completeJob, deferJob, failJob, releaseWorkerLeases, type JobType } from './queue';
import { defaultDmDriver, HANDLERS, reportDeadJob, scheduleRecurringJobs } from './handlers';

const log = createLogger('worker');

/** How often the loop re-enqueues recurring work. Enqueueing is idempotent per bucket. */
const RESCHEDULE_INTERVAL_MS = 60_000;

/**
 * Worker runtime: claim, execute, record. A job that throws a retryable error
 * goes back to the queue with backoff; anything else dead-letters and surfaces
 * to the operator.
 */

export interface WorkerOptions {
  workerId?: string;
  dmDriver?: DmDriver;
  apiSender?: ApiSender;
  /** Restricts the worker to a subset of job types (used by tests). */
  types?: JobType[];
  now?: () => Date;
}

export interface RunOnceResult {
  ranJob: boolean;
  jobId?: string;
  jobType?: JobType;
  status?: 'succeeded' | 'retrying' | 'dead' | 'skipped';
  detail?: string;
}

/** Capability a job type needs before it may run at all. */
const REQUIRED_CAPABILITY: Partial<Record<JobType, 'browser_outreach' | 'api_messaging'>> = {
  send_first_dm: 'browser_outreach',
  discover_leads: 'browser_outreach',
  // `dispatch_outreach` is deliberately absent: it only reads state and queues
  // work, so parking it on a paused capability would leave an immortal poll
  // tick behind (a deferral hands the attempt back, and a new tick is enqueued
  // every two minutes regardless). It checks the capability itself instead.
  send_api_reply: 'api_messaging',
  followup: 'api_messaging',
};

/** How long a job waits when the capability it needs is switched off. */
const CAPABILITY_RETRY_MS = 300_000;

export async function runOnce(options: WorkerOptions = {}): Promise<RunOnceResult> {
  const db: Db = getDb();
  const workerId = options.workerId ?? `worker-${process.pid}`;
  const now = options.now?.() ?? new Date();

  const job = claimNextJob(workerId, now, options.types);
  if (!job) return { ranJob: false };

  const jobType = job.type as JobType;
  const handler = HANDLERS[jobType];
  if (!handler) {
    failJob(job.id, `Tipo de job desconhecido: ${job.type}`, { retryable: false }, db);
    return { ranJob: true, jobId: job.id, jobType, status: 'dead', detail: 'tipo desconhecido' };
  }

  const required = REQUIRED_CAPABILITY[jobType];
  if (required && !isCapabilityUsable(required, db)) {
    // Not a failure: the capability is off or paused, and the job was never
    // attempted. Park it and hand back the attempt the claim just spent.
    deferJob(job.id, new Date(now.getTime() + CAPABILITY_RETRY_MS), `Capacidade "${required}" indisponível.`, db);
    return { ranJob: true, jobId: job.id, jobType, status: 'skipped', detail: `capacidade ${required} indisponível` };
  }

  const dmDriver = options.dmDriver ?? defaultDmDriver();

  try {
    const detail = await handler({ job, db, dmDriver, apiSender: options.apiSender, now });
    completeJob(job.id, db);
    recordEvent({ type: 'job.succeeded', leadId: job.leadId, payload: { jobType, detail } }, db);
    log.info('job finished', { jobId: job.id, jobType, detail });
    return { ranJob: true, jobId: job.id, jobType, status: 'succeeded', detail };
  } catch (error) {
    const payload = toErrorPayload(error);
    const retryable = isAppError(error) ? error.retryable : false;
    const retryAt =
      isAppError(error) && typeof error.details.retryAt === 'string' ? new Date(error.details.retryAt) : undefined;

    // "Not yet" is not "it failed": the handler refused to start, so the job
    // goes back to the queue with its attempt budget intact.
    if (isAppError(error) && error.deferral) {
      const when = retryAt ?? new Date(now.getTime() + CAPABILITY_RETRY_MS);
      deferJob(job.id, when, `${payload.code}: ${payload.message}`, db);
      log.info('job deferred', { jobId: job.id, jobType, code: payload.code, retryAt: when.toISOString() });
      return { ranJob: true, jobId: job.id, jobType, status: 'skipped', detail: payload.message };
    }

    const updated = failJob(job.id, `${payload.code}: ${payload.message}`, { retryable, retryAt }, db);

    if (updated.status === 'dead') {
      reportDeadJob(job, `${payload.code}: ${payload.message}`, db);
      log.error('job dead-lettered', { jobId: job.id, jobType, code: payload.code });
      return { ranJob: true, jobId: job.id, jobType, status: 'dead', detail: payload.message };
    }

    log.warn('job will retry', { jobId: job.id, jobType, code: payload.code });
    return { ranJob: true, jobId: job.id, jobType, status: 'retrying', detail: payload.message };
  }
}

export interface WorkerHandle {
  stop: () => Promise<void>;
}

export function startWorker(options: WorkerOptions = {}): WorkerHandle {
  const workerId = options.workerId ?? `worker-${process.pid}-${randomUUID().slice(0, 8)}`;
  const controller = new AbortController();
  const pollMs = getEnv().WORKER_POLL_INTERVAL_MS;

  // Any lease this worker id still holds from a previous crash is released
  // before the loop starts, which is what makes restart recovery immediate.
  const released = releaseWorkerLeases(workerId);
  if (released > 0) log.info('released stale leases', { released });
  scheduleRecurringJobs(new Date());
  let lastScheduledAt = Date.now();

  const loop = (async () => {
    log.info('worker started', { workerId });
    while (!controller.signal.aborted) {
      try {
        if (Date.now() - lastScheduledAt >= RESCHEDULE_INTERVAL_MS) {
          // Enqueueing is idempotent per time bucket, so re-running this is free
          // and keeps recurring work alive on a long-lived process.
          scheduleRecurringJobs(new Date());
          lastScheduledAt = Date.now();
        }
        const result = await runOnce({ ...options, workerId });
        if (!result.ranJob) await sleep(pollMs, controller.signal).catch(() => undefined);
      } catch (error) {
        if (error instanceof AppError) {
          log.error('worker loop error', { code: error.code, message: error.message });
        } else {
          log.error('worker loop error', { message: error instanceof Error ? error.message : String(error) });
        }
        await sleep(pollMs, controller.signal).catch(() => undefined);
      }
    }
    log.info('worker stopped', { workerId });
  })();

  return {
    stop: async () => {
      controller.abort();
      await loop;
      releaseWorkerLeases(workerId);
    },
  };
}
