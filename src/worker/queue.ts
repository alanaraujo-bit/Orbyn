import { and, asc, desc, eq, inArray, lte, or, sql } from 'drizzle-orm';
import { getDb, transact, type Db } from '@/db/client';
import { jobs, type JobRow } from '@/db/schema';
import { AppError } from '@/lib/errors';
import { newId } from '@/lib/ids';
import { addSeconds, nowIso } from '@/lib/time';
import { recordAudit, recordEvent } from '@/lib/audit';

/**
 * Durable job queue on SQLite.
 *
 * No commercial side effect depends on Node process memory: a job is claimed
 * with a lease, and a lease that outlives its worker is reclaimed on the next
 * poll, which is what makes restart recovery work.
 */

export const JOB_TYPES = [
  'discover_leads',
  'qualify_lead',
  'send_first_dm',
  'process_inbound',
  'send_api_reply',
  'followup',
  'expire_api_windows',
  'retention_cleanup',
  'backup_database',
  'optimize_strategy',
  'check_webhook_reachability',
] as const;

export type JobType = (typeof JOB_TYPES)[number];

export type JobStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'dead' | 'canceled';

export const LEASE_SECONDS = 300;
const BASE_BACKOFF_SECONDS = 30;
const MAX_BACKOFF_SECONDS = 3600;

export interface EnqueueInput {
  type: JobType;
  payload?: Record<string, unknown>;
  scheduledAt?: Date;
  maxAttempts?: number;
  idempotencyKey?: string;
  leadId?: string | null;
  priority?: number;
}

export interface EnqueueResult {
  job: JobRow;
  duplicate: boolean;
}

export function enqueue(input: EnqueueInput, db: Db = getDb()): EnqueueResult {
  if (input.idempotencyKey) {
    const existing = db.select().from(jobs).where(eq(jobs.idempotencyKey, input.idempotencyKey)).get();
    if (existing) return { job: existing, duplicate: true };
  }
  const now = nowIso();
  const row: JobRow = {
    id: newId('job'),
    type: input.type,
    payload: JSON.stringify(input.payload ?? {}),
    status: 'pending',
    priority: input.priority ?? 0,
    attempts: 0,
    maxAttempts: input.maxAttempts ?? 3,
    scheduledAt: (input.scheduledAt ?? new Date()).toISOString(),
    startedAt: null,
    completedAt: null,
    failedAt: null,
    error: null,
    idempotencyKey: input.idempotencyKey ?? null,
    lockedBy: null,
    lockedAt: null,
    lockExpiresAt: null,
    leadId: input.leadId ?? null,
    createdAt: now,
    updatedAt: now,
  };
  try {
    db.insert(jobs).values(row).run();
  } catch (error) {
    if (input.idempotencyKey) {
      const again = db.select().from(jobs).where(eq(jobs.idempotencyKey, input.idempotencyKey)).get();
      if (again) return { job: again, duplicate: true };
    }
    throw error;
  }
  return { job: row, duplicate: false };
}

export function getJob(id: string, db: Db = getDb()): JobRow {
  const row = db.select().from(jobs).where(eq(jobs.id, id)).get();
  if (!row) throw new AppError('not_found', `Job ${id} não encontrado.`);
  return row;
}

/**
 * Atomically claims one runnable job. Also reclaims jobs whose lease expired,
 * which is how work survives a worker crash.
 */
export function claimNextJob(workerId: string, now: Date = new Date(), types?: JobType[]): JobRow | undefined {
  return transact((db) => {
    const nowIsoValue = now.toISOString();
    const runnable = and(
      or(
        and(eq(jobs.status, 'pending'), lte(jobs.scheduledAt, nowIsoValue)),
        and(eq(jobs.status, 'running'), lte(jobs.lockExpiresAt, nowIsoValue)),
      ),
      types && types.length > 0 ? inArray(jobs.type, types) : undefined,
    );

    const candidate = db
      .select()
      .from(jobs)
      .where(runnable)
      .orderBy(desc(jobs.priority), asc(jobs.scheduledAt))
      .limit(1)
      .get();

    if (!candidate) return undefined;

    const attempts = candidate.attempts + 1;
    const updated = db
      .update(jobs)
      .set({
        status: 'running',
        attempts,
        startedAt: nowIsoValue,
        lockedBy: workerId,
        lockedAt: nowIsoValue,
        lockExpiresAt: addSeconds(now, LEASE_SECONDS).toISOString(),
        updatedAt: nowIsoValue,
      })
      .where(and(eq(jobs.id, candidate.id), eq(jobs.updatedAt, candidate.updatedAt)))
      .run();

    if (updated.changes === 0) return undefined;

    if (candidate.status === 'running') {
      recordEvent({ type: 'job.lease_reclaimed', payload: { jobId: candidate.id, jobType: candidate.type } }, db);
    }

    return {
      ...candidate,
      status: 'running' as const,
      attempts,
      startedAt: nowIsoValue,
      lockedBy: workerId,
      lockExpiresAt: addSeconds(now, LEASE_SECONDS).toISOString(),
      updatedAt: nowIsoValue,
    };
  });
}

export function completeJob(id: string, db: Db = getDb()): void {
  const now = nowIso();
  db.update(jobs)
    .set({ status: 'succeeded', completedAt: now, lockedBy: null, lockExpiresAt: null, error: null, updatedAt: now })
    .where(eq(jobs.id, id))
    .run();
}

export interface FailureOptions {
  retryable: boolean;
  /** Explicit next attempt time; otherwise exponential backoff is used. */
  retryAt?: Date;
}

export function failJob(id: string, error: string, options: FailureOptions, db: Db = getDb()): JobRow {
  const job = getJob(id, db);
  const now = new Date();
  const exhausted = job.attempts >= job.maxAttempts;
  const goesDead = !options.retryable || exhausted;

  if (goesDead) {
    db.update(jobs)
      .set({
        status: 'dead',
        failedAt: now.toISOString(),
        error: error.slice(0, 2000),
        lockedBy: null,
        lockExpiresAt: null,
        updatedAt: now.toISOString(),
      })
      .where(eq(jobs.id, id))
      .run();
    recordEvent({ type: 'job.dead_letter', payload: { jobId: id, jobType: job.type, error: error.slice(0, 300) } }, db);
    recordAudit(
      { actor: 'worker', action: 'job.dead_letter', entityType: 'job', entityId: id, after: { error: error.slice(0, 300) } },
      db,
    );
    return { ...job, status: 'dead' };
  }

  const backoff = Math.min(BASE_BACKOFF_SECONDS * 2 ** (job.attempts - 1), MAX_BACKOFF_SECONDS);
  const retryAt = options.retryAt ?? addSeconds(now, backoff);
  db.update(jobs)
    .set({
      status: 'pending',
      scheduledAt: retryAt.toISOString(),
      error: error.slice(0, 2000),
      lockedBy: null,
      lockExpiresAt: null,
      updatedAt: now.toISOString(),
    })
    .where(eq(jobs.id, id))
    .run();
  return { ...job, status: 'pending', scheduledAt: retryAt.toISOString() };
}

export function cancelJob(id: string, reason: string, db: Db = getDb()): void {
  const now = nowIso();
  db.update(jobs)
    .set({ status: 'canceled', error: reason, lockedBy: null, lockExpiresAt: null, updatedAt: now })
    .where(and(eq(jobs.id, id), inArray(jobs.status, ['pending', 'running'])))
    .run();
}

/** Used by opt-out: nothing pending for that lead may ever run. */
export function cancelJobsForLead(leadId: string, reason: string, db: Db = getDb()): number {
  const now = nowIso();
  const result = db
    .update(jobs)
    .set({ status: 'canceled', error: reason, lockedBy: null, lockExpiresAt: null, updatedAt: now })
    .where(and(eq(jobs.leadId, leadId), inArray(jobs.status, ['pending', 'running'])))
    .run();
  return result.changes;
}

export function requeueJob(id: string, at: Date = new Date(), db: Db = getDb()): void {
  const now = nowIso();
  db.update(jobs)
    .set({ status: 'pending', scheduledAt: at.toISOString(), lockedBy: null, lockExpiresAt: null, updatedAt: now })
    .where(eq(jobs.id, id))
    .run();
}

export interface JobFilter {
  statuses?: JobStatus[];
  types?: JobType[];
  limit?: number;
}

export function listJobs(filter: JobFilter = {}, db: Db = getDb()): JobRow[] {
  const conditions = [];
  if (filter.statuses && filter.statuses.length > 0) conditions.push(inArray(jobs.status, filter.statuses));
  if (filter.types && filter.types.length > 0) conditions.push(inArray(jobs.type, filter.types));
  const base = db.select().from(jobs);
  const filtered = conditions.length > 0 ? base.where(and(...conditions)) : base;
  return filtered.orderBy(desc(jobs.updatedAt)).limit(filter.limit ?? 200).all();
}

export interface QueueStats {
  pending: number;
  running: number;
  succeeded: number;
  failed: number;
  dead: number;
  canceled: number;
}

export function queueStats(db: Db = getDb()): QueueStats {
  const rows = db
    .select({ status: jobs.status, count: sql<number>`count(*)` })
    .from(jobs)
    .groupBy(jobs.status)
    .all();
  const stats: QueueStats = { pending: 0, running: 0, succeeded: 0, failed: 0, dead: 0, canceled: 0 };
  for (const row of rows) {
    if (row.status in stats) stats[row.status as keyof QueueStats] = Number(row.count);
  }
  return stats;
}

/** Releases leases held by a worker that is shutting down. */
export function releaseWorkerLeases(workerId: string, db: Db = getDb()): number {
  const now = nowIso();
  const result = db
    .update(jobs)
    .set({ status: 'pending', lockedBy: null, lockExpiresAt: null, updatedAt: now })
    .where(and(eq(jobs.status, 'running'), eq(jobs.lockedBy, workerId)))
    .run();
  return result.changes;
}
