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
import { claimNextJob, completeJob, failJob, releaseWorkerLeases, type JobType } from './queue';
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
  send_api_reply: 'api_messaging',
  followup: 'api_messaging',
};

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
    // Not a failure: the capability is off or paused. Park the job instead of
    // burning its attempts.
    failJob(job.id, `Capacidade "${required}" indisponível.`, { retryable: true, retryAt: new Date(now.getTime() + 300_000) }, db);
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
