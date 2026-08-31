import { describe, expect, it, beforeEach } from 'vitest';
import { withTestDatabase } from '../helpers/db';
import { resetEnvCache } from '@/lib/env';
import {
  assertCeilingRespected,
  effectiveDailyCap,
  evaluatePacing,
  incrementDmCounter,
  scheduleNextDm,
  startWarmup,
  warmupCapFor,
} from '@/features/campaigns/guardrails';
import { writeStrategy } from '@/features/experiments/strategy-store';

withTestDatabase();

beforeEach(() => {
  process.env.OPERATING_HOURS = '09:00-20:00';
  process.env.OPERATING_TIMEZONE = 'America/Belem';
  process.env.MAX_DMS_PER_DAY = '30';
  process.env.MIN_SECONDS_BETWEEN_DMS = '90';
  process.env.MAX_SECONDS_BETWEEN_DMS = '240';
  resetEnvCache();
});

/** 2026-08-30 13:00 UTC is 10:00 in America/Belem (UTC-3). */
const insideHours = new Date('2026-08-30T13:00:00Z');
const outsideHours = new Date('2026-08-30T04:00:00Z');

describe('operating hours', () => {
  it('blocks outside the configured window and points at the next slot', () => {
    const decision = evaluatePacing(outsideHours);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('horário');
    expect(decision.retryAt).toBeDefined();
  });

  it('allows inside the window', () => {
    expect(evaluatePacing(insideHours).allowed).toBe(true);
  });

  it('never schedules a DM outside the window', () => {
    const scheduled = scheduleNextDm(new Date('2026-08-30T22:59:00Z'));
    const hourInBelem = Number(
      new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Belem', hour: '2-digit', hour12: false }).format(scheduled),
    );
    expect(hourInBelem).toBeGreaterThanOrEqual(9);
    expect(hourInBelem).toBeLessThan(20);
  });
});

describe('warm-up and daily ceiling', () => {
  it('starts at 5 per day and grows by 5 each week', () => {
    startWarmup('2026-08-03');
    expect(warmupCapFor(new Date('2026-08-05T13:00:00Z'))).toBe(5);
    expect(warmupCapFor(new Date('2026-08-12T13:00:00Z'))).toBe(10);
    expect(warmupCapFor(new Date('2026-08-19T13:00:00Z'))).toBe(15);
  });

  it('never exceeds the operator ceiling, however long the warm-up runs', () => {
    startWarmup('2025-01-01');
    expect(warmupCapFor(insideHours)).toBe(30);
    expect(effectiveDailyCap(insideHours)).toBe(30);
  });

  it('refuses any request to exceed the ceiling', () => {
    expect(() => assertCeilingRespected(31)).toThrow(/teto do operador/);
    expect(() => assertCeilingRespected(30)).not.toThrow();
  });

  it('blocks further DMs once the daily cap is reached', () => {
    startWarmup('2026-08-30');
    const cap = effectiveDailyCap(insideHours);
    for (let index = 0; index < cap; index += 1) incrementDmCounter(insideHours);
    const decision = evaluatePacing(insideHours);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('Limite diário');
  });

  it('cannot be raised by the optimizer writing to the strategy store', () => {
    startWarmup('2025-01-01');
    writeStrategy('warmup_schedule', { startedOn: '2020-01-01', initialPerDay: 500, weeklyIncrement: 500 }, 'optimizer');
    // The learned value is honoured only as far as the operator ceiling.
    expect(effectiveDailyCap(insideHours)).toBe(30);
  });
});
