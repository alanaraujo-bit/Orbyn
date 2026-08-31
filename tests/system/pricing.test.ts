import { beforeEach, describe, expect, it } from 'vitest';
import { withTestDatabase } from '../helpers/db';
import { resetEnvCache } from '@/lib/env';
import { assertBudgetAvailable, budgetStatus, estimateCost, recordAiCall } from '@/integrations/openai/usage';
import { capabilityReport } from '@/features/system/capabilities';
import { costMetrics } from '@/features/analytics/metrics';

withTestDatabase();

/** Official prices used by the operator, per 1M tokens. */
const TERRA = { input: 2.0, cachedInput: 0.2, output: 12.0 };
const LUNA = { input: 0.2, cachedInput: 0.02, output: 1.2 };

function applyPrices(): void {
  process.env.OPENAI_MONTHLY_BUDGET_USD = '20';
  process.env.OPENAI_PRICE_INPUT_PER_1M = String(TERRA.input);
  process.env.OPENAI_PRICE_CACHED_INPUT_PER_1M = String(TERRA.cachedInput);
  process.env.OPENAI_PRICE_OUTPUT_PER_1M = String(TERRA.output);
  process.env.OPENAI_FAST_PRICE_INPUT_PER_1M = String(LUNA.input);
  process.env.OPENAI_FAST_PRICE_CACHED_INPUT_PER_1M = String(LUNA.cachedInput);
  process.env.OPENAI_FAST_PRICE_OUTPUT_PER_1M = String(LUNA.output);
  resetEnvCache();
}

beforeEach(applyPrices);

describe('cost calculation', () => {
  it('prices the reasoning tier with no cache hit', () => {
    // 1M input @ $2 + 1M output @ $12
    const result = estimateCost('reasoning', { inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(result).toEqual({ costUsd: 14, priced: true, cachedPriceMissing: false });
  });

  it('prices the fast tier with no cache hit', () => {
    const result = estimateCost('fast', { inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(result.costUsd).toBeCloseTo(1.4, 6);
  });

  it('splits input between full price and cached price', () => {
    // 1M total input, 750k from cache: 250k @ $2 + 750k @ $0.20 + 0 output
    const result = estimateCost('reasoning', {
      inputTokens: 1_000_000,
      cachedInputTokens: 750_000,
      outputTokens: 0,
    });
    expect(result.costUsd).toBeCloseTo(0.25 * 2 + 0.75 * 0.2, 6);
    expect(result.costUsd).toBeCloseTo(0.65, 6);
    expect(result.cachedPriceMissing).toBe(false);
  });

  it('a fully cached prompt costs the cached rate, not the full rate', () => {
    const cached = estimateCost('reasoning', {
      inputTokens: 1_000_000,
      cachedInputTokens: 1_000_000,
      outputTokens: 0,
    });
    const uncached = estimateCost('reasoning', { inputTokens: 1_000_000, outputTokens: 0 });
    expect(cached.costUsd).toBeCloseTo(0.2, 6);
    expect(uncached.costUsd).toBeCloseTo(2, 6);
  });

  it('falls back to the full input rate when cached input has no price', () => {
    process.env.OPENAI_PRICE_CACHED_INPUT_PER_1M = '';
    resetEnvCache();
    const result = estimateCost('reasoning', {
      inputTokens: 1_000_000,
      cachedInputTokens: 1_000_000,
      outputTokens: 0,
    });
    // Conservative: charged as if nothing was cached, and flagged.
    expect(result.costUsd).toBeCloseTo(2, 6);
    expect(result.cachedPriceMissing).toBe(true);
  });

  it('clamps a cached count larger than the total input', () => {
    const result = estimateCost('reasoning', {
      inputTokens: 1_000,
      cachedInputTokens: 999_999,
      outputTokens: 0,
    });
    // Never negative, never cheaper than "all cached".
    expect(result.costUsd).toBeGreaterThan(0);
    expect(result.costUsd).toBeCloseTo((1_000 / 1_000_000) * TERRA.cachedInput, 9);
  });

  it('reports not-priced when the operator left prices empty', () => {
    process.env.OPENAI_PRICE_INPUT_PER_1M = '';
    process.env.OPENAI_PRICE_OUTPUT_PER_1M = '';
    resetEnvCache();
    expect(estimateCost('reasoning', { inputTokens: 500, outputTokens: 500 })).toEqual({
      costUsd: 0,
      priced: false,
      cachedPriceMissing: false,
    });
  });
});

describe('usage ledger', () => {
  it('persists cached tokens and a cost above zero', () => {
    const row = recordAiCall({
      model: 'gpt-5.6-terra',
      operation: 'generate_opener',
      status: 'succeeded',
      tier: 'reasoning',
      usage: { inputTokens: 10_000, cachedInputTokens: 4_000, outputTokens: 500 },
    });

    expect(row.inputTokens).toBe(10_000);
    expect(row.cachedInputTokens).toBe(4_000);
    expect(row.costUsd).toBeGreaterThan(0);
    // 6k @ $2/1M + 4k @ $0.20/1M + 500 @ $12/1M
    expect(row.costUsd).toBeCloseTo(0.006 * 2 + 0.004 * 0.2 + 0.0005 * 12, 6);
  });

  it('aggregates real spend and cached tokens into the panel metrics', () => {
    recordAiCall({
      model: 'gpt-5.6-terra',
      operation: 'generate_opener',
      status: 'succeeded',
      tier: 'reasoning',
      usage: { inputTokens: 100_000, cachedInputTokens: 20_000, outputTokens: 10_000 },
    });

    const metrics = costMetrics();
    expect(metrics.spentUsd).toBeGreaterThan(0);
    expect(metrics.cachedInputTokens).toBe(20_000);
    expect(metrics.hasUnpricedCalls).toBe(false);
    expect(metrics.budgetUsd).toBe(20);
  });
});

describe('budget cutoff at US$ 20', () => {
  it('stays open below the ceiling', () => {
    recordAiCall({
      model: 'gpt-5.6-terra',
      operation: 'generate_opener',
      status: 'succeeded',
      tier: 'reasoning',
      usage: { inputTokens: 1_000_000, outputTokens: 100_000 },
    });
    const status = budgetStatus();
    expect(status.spentUsd).toBeCloseTo(3.2, 6);
    expect(status.exceeded).toBe(false);
    expect(status.remainingUsd).toBeCloseTo(16.8, 6);
    expect(() => assertBudgetAvailable()).not.toThrow();
  });

  it('blocks and pauses the engine once US$ 20 is reached', () => {
    // 10M output tokens on the reasoning tier = $120, well past the ceiling.
    recordAiCall({
      model: 'gpt-5.6-terra',
      operation: 'plan_reply',
      status: 'succeeded',
      tier: 'reasoning',
      usage: { inputTokens: 0, outputTokens: 10_000_000 },
    });

    const status = budgetStatus();
    expect(status.spentUsd).toBeCloseTo(120, 6);
    expect(status.exceeded).toBe(true);
    expect(status.remainingUsd).toBe(0);

    expect(() => assertBudgetAvailable()).toThrow(/Orçamento mensal/);
    expect(capabilityReport().find((entry) => entry.id === 'ai_engine')?.paused).toBe(true);
  });

  it('crossing the ceiling exactly is enough to block', () => {
    // Exactly US$ 20 of output on the fast tier.
    recordAiCall({
      model: 'gpt-5.6-luna',
      operation: 'classify_intent',
      status: 'succeeded',
      tier: 'fast',
      usage: { inputTokens: 0, outputTokens: (20 / LUNA.output) * 1_000_000 },
    });
    const status = budgetStatus();
    expect(status.spentUsd).toBeCloseTo(20, 4);
    expect(status.exceeded).toBe(true);
  });
});
