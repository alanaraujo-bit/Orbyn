import { eq } from 'drizzle-orm';
import { getDb, type Db } from '@/db/client';
import { circuitBreakers } from '@/db/schema';
import { AppError } from './errors';
import { addSeconds, nowIso } from './time';

/**
 * Durable circuit breakers. State lives in SQLite so a worker restart cannot
 * reopen a circuit that a failing integration had already tripped.
 */

export type BreakerName = 'browser' | 'instagram_api' | 'openai' | 'webhook';
export type BreakerState = 'closed' | 'open' | 'half_open';

export interface BreakerConfig {
  threshold: number;
  cooldownSeconds: number;
}

const DEFAULTS: Record<BreakerName, BreakerConfig> = {
  browser: { threshold: 3, cooldownSeconds: 1800 },
  instagram_api: { threshold: 5, cooldownSeconds: 900 },
  openai: { threshold: 5, cooldownSeconds: 300 },
  webhook: { threshold: 10, cooldownSeconds: 300 },
};

interface BreakerRow {
  name: string;
  state: string;
  failureCount: number;
  successCount: number;
  threshold: number;
  cooldownSeconds: number;
  openedAt: string | null;
  nextAttemptAt: string | null;
  lastError: string | null;
}

function ensureRow(name: BreakerName, db: Db): BreakerRow {
  const found = db.select().from(circuitBreakers).where(eq(circuitBreakers.name, name)).get();
  if (found) return found as BreakerRow;
  const config = DEFAULTS[name];
  const now = nowIso();
  db.insert(circuitBreakers)
    .values({
      name,
      state: 'closed',
      failureCount: 0,
      successCount: 0,
      threshold: config.threshold,
      cooldownSeconds: config.cooldownSeconds,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .run();
  return db.select().from(circuitBreakers).where(eq(circuitBreakers.name, name)).get() as BreakerRow;
}

export interface BreakerStatus {
  name: BreakerName;
  state: BreakerState;
  failureCount: number;
  nextAttemptAt: string | null;
  lastError: string | null;
}

export function breakerStatus(name: BreakerName, db: Db = getDb()): BreakerStatus {
  const row = ensureRow(name, db);
  const state = resolveState(row);
  return {
    name,
    state,
    failureCount: row.failureCount,
    nextAttemptAt: row.nextAttemptAt,
    lastError: row.lastError,
  };
}

function resolveState(row: BreakerRow): BreakerState {
  if (row.state !== 'open') return row.state as BreakerState;
  if (row.nextAttemptAt && new Date(row.nextAttemptAt).getTime() <= Date.now()) return 'half_open';
  return 'open';
}

export function assertBreakerClosed(name: BreakerName, db: Db = getDb()): void {
  const status = breakerStatus(name, db);
  if (status.state === 'open') {
    throw new AppError('circuit_open', `Circuito "${name}" aberto até ${status.nextAttemptAt ?? 'novo aviso'}.`, {
      details: { breaker: name, nextAttemptAt: status.nextAttemptAt },
      retryable: true,
    });
  }
}

export function recordBreakerSuccess(name: BreakerName, db: Db = getDb()): void {
  ensureRow(name, db);
  db.update(circuitBreakers)
    .set({ state: 'closed', failureCount: 0, successCount: 0, openedAt: null, nextAttemptAt: null, updatedAt: nowIso() })
    .where(eq(circuitBreakers.name, name))
    .run();
}

export function recordBreakerFailure(name: BreakerName, error: string, db: Db = getDb()): BreakerState {
  const row = ensureRow(name, db);
  const failureCount = row.failureCount + 1;
  const now = new Date();
  const shouldOpen = failureCount >= row.threshold;
  db.update(circuitBreakers)
    .set({
      failureCount,
      state: shouldOpen ? 'open' : 'closed',
      openedAt: shouldOpen ? now.toISOString() : row.openedAt,
      nextAttemptAt: shouldOpen ? addSeconds(now, row.cooldownSeconds).toISOString() : row.nextAttemptAt,
      lastError: error.slice(0, 500),
      updatedAt: now.toISOString(),
    })
    .where(eq(circuitBreakers.name, name))
    .run();
  return shouldOpen ? 'open' : 'closed';
}

export function resetBreaker(name: BreakerName, db: Db = getDb()): void {
  recordBreakerSuccess(name, db);
}
