import { and, desc, eq, sql } from 'drizzle-orm';
import { getDb, type Db } from '@/db/client';
import { dailyCounters, messages } from '@/db/schema';
import { AppError } from '@/lib/errors';
import { getEnv, operatingHours } from '@/lib/env';
import {
  addSeconds,
  isWithinOperatingHours,
  nextOperatingSlot,
  randomIntBetween,
  zonedDayKey,
} from '@/lib/time';
import { readStrategy, writeStrategy } from '@/features/experiments/strategy-store';

/**
 * Outreach guardrails.
 *
 * The values in `.env` are ceilings set by the operator. The optimizer may pace
 * *below* them; nothing in the system may raise them. `assertCeilingRespected`
 * is the single place that enforces that invariant.
 */

export const DM_COUNTER_METRIC = 'browser_dms_sent';

export interface WarmupState {
  /** Local day the warm-up started, e.g. `2026-08-30`. */
  startedOn: string;
  initialPerDay: number;
  weeklyIncrement: number;
}

const DEFAULT_WARMUP: WarmupState = { startedOn: '', initialPerDay: 5, weeklyIncrement: 5 };

export function getWarmupState(db: Db = getDb()): WarmupState {
  const stored = readStrategy<WarmupState>('warmup_schedule', db);
  if (!stored) return DEFAULT_WARMUP;
  return { ...DEFAULT_WARMUP, ...stored };
}

export function startWarmup(day: string, db: Db = getDb()): WarmupState {
  const next = { ...getWarmupState(db), startedOn: day };
  writeStrategy('warmup_schedule', next, 'system', db);
  return next;
}

/** 5/day in week 1, +5 each subsequent week, never above MAX_DMS_PER_DAY. */
export function warmupCapFor(now: Date, db: Db = getDb()): number {
  const env = getEnv();
  const state = getWarmupState(db);
  const today = zonedDayKey(now, env.OPERATING_TIMEZONE);
  const startedOn = state.startedOn === '' ? startWarmup(today, db).startedOn : state.startedOn;
  const startMs = Date.parse(`${startedOn}T00:00:00Z`);
  const todayMs = Date.parse(`${today}T00:00:00Z`);
  const weekIndex = Math.max(0, Math.floor((todayMs - startMs) / (7 * 86_400_000)));
  const capped = state.initialPerDay + weekIndex * state.weeklyIncrement;
  return Math.min(capped, env.MAX_DMS_PER_DAY);
}

export function effectiveDailyCap(now: Date = new Date(), db: Db = getDb()): number {
  return Math.min(getEnv().MAX_DMS_PER_DAY, warmupCapFor(now, db));
}

/**
 * The optimizer may only ever request a *lower* daily volume. Any attempt to
 * exceed the operator ceiling is refused and surfaced as an error.
 */
export function assertCeilingRespected(requestedPerDay: number): void {
  const ceiling = getEnv().MAX_DMS_PER_DAY;
  if (requestedPerDay > ceiling) {
    throw new AppError('rate_limit_exceeded', `Volume solicitado (${requestedPerDay}) excede o teto do operador (${ceiling}).`, {
      details: { requestedPerDay, ceiling },
    });
  }
}

export function dmsSentToday(now: Date = new Date(), db: Db = getDb()): number {
  const day = zonedDayKey(now, getEnv().OPERATING_TIMEZONE);
  const row = db
    .select({ value: dailyCounters.value })
    .from(dailyCounters)
    .where(and(eq(dailyCounters.day, day), eq(dailyCounters.metric, DM_COUNTER_METRIC)))
    .get();
  return row?.value ?? 0;
}

export function incrementDmCounter(now: Date = new Date(), db: Db = getDb()): number {
  const day = zonedDayKey(now, getEnv().OPERATING_TIMEZONE);
  db.insert(dailyCounters)
    .values({ day, metric: DM_COUNTER_METRIC, value: 1 })
    .onConflictDoUpdate({
      target: [dailyCounters.day, dailyCounters.metric],
      set: { value: sql`${dailyCounters.value} + 1` },
    })
    .run();
  return dmsSentToday(now, db);
}

export interface PacingDecision {
  allowed: boolean;
  reason?: string;
  /** When not allowed now, the earliest instant the action may be retried. */
  retryAt?: Date;
  sentToday: number;
  cap: number;
}

export function evaluatePacing(now: Date = new Date(), db: Db = getDb()): PacingDecision {
  const env = getEnv();
  const hours = operatingHours();
  const cap = effectiveDailyCap(now, db);
  const sentToday = dmsSentToday(now, db);

  if (!isWithinOperatingHours(now, hours, env.OPERATING_TIMEZONE)) {
    return {
      allowed: false,
      reason: 'Fora do horário de operação.',
      retryAt: nextOperatingSlot(now, hours, env.OPERATING_TIMEZONE),
      sentToday,
      cap,
    };
  }

  if (sentToday >= cap) {
    const tomorrow = nextOperatingSlot(addSeconds(now, 86_400), hours, env.OPERATING_TIMEZONE);
    return { allowed: false, reason: `Limite diário atingido (${sentToday}/${cap}).`, retryAt: tomorrow, sentToday, cap };
  }

  const lastSentAt = lastBrowserDmAt(db);
  if (lastSentAt) {
    const minGapMs = env.MIN_SECONDS_BETWEEN_DMS * 1000;
    const elapsed = now.getTime() - lastSentAt.getTime();
    if (elapsed < minGapMs) {
      return {
        allowed: false,
        reason: 'Intervalo mínimo entre DMs ainda não decorrido.',
        retryAt: new Date(lastSentAt.getTime() + minGapMs),
        sentToday,
        cap,
      };
    }
  }

  return { allowed: true, sentToday, cap };
}

export function lastBrowserDmAt(db: Db = getDb()): Date | null {
  const row = db
    .select({ sentAt: messages.sentAt })
    .from(messages)
    .where(and(eq(messages.channel, 'browser'), eq(messages.direction, 'outbound')))
    .orderBy(desc(messages.sentAt))
    .limit(1)
    .get();
  return row?.sentAt ? new Date(row.sentAt) : null;
}

/** Randomised, human-paced delay for the next browser DM. */
export function scheduleNextDm(from: Date = new Date()): Date {
  const env = getEnv();
  const gap = randomIntBetween(env.MIN_SECONDS_BETWEEN_DMS, env.MAX_SECONDS_BETWEEN_DMS);
  const candidate = addSeconds(from, gap);
  return nextOperatingSlot(candidate, operatingHours(), env.OPERATING_TIMEZONE);
}
