import { desc, gte, sql } from 'drizzle-orm';
import { getDb, type Db } from '@/db/client';
import { aiCalls, type AiCallRow } from '@/db/schema';
import { getEnv } from '@/lib/env';
import { newId } from '@/lib/ids';
import { nowIso } from '@/lib/time';
import { AppError } from '@/lib/errors';
import { raiseAlert } from '@/lib/audit';
import { pauseCapability } from '@/features/system/capabilities';

/**
 * AI usage accounting and budget enforcement.
 *
 * Prices are never guessed. When the operator has not declared the price of a
 * model, the call is still recorded with its token counts and `cost_usd = 0`,
 * and the panel reports the cost as not calculated rather than showing a
 * fabricated number.
 *
 * Prompt caching: the Responses API reports `input_tokens` as the TOTAL input
 * and `input_tokens_details.cached_tokens` as the subset served from cache.
 * Cached tokens bill at a lower rate, so cost splits the input in two. When the
 * operator priced input but not cached input, cached tokens are charged at the
 * full input rate - a conservative overestimate, never an invented discount.
 */

export type AiTier = 'reasoning' | 'fast';

export interface TokenUsage {
  /** Total input tokens, cached ones included. */
  inputTokens: number;
  /** Subset of inputTokens served from the prompt cache. */
  cachedInputTokens?: number;
  outputTokens: number;
}

export interface CostEstimate {
  costUsd: number;
  priced: boolean;
  /** Set when cached tokens had to be billed at the full input rate. */
  cachedPriceMissing: boolean;
}

interface TierPrices {
  input: number | undefined;
  cachedInput: number | undefined;
  output: number | undefined;
}

function pricesFor(tier: AiTier): TierPrices {
  const env = getEnv();
  return tier === 'fast'
    ? {
        input: env.OPENAI_FAST_PRICE_INPUT_PER_1M,
        cachedInput: env.OPENAI_FAST_PRICE_CACHED_INPUT_PER_1M,
        output: env.OPENAI_FAST_PRICE_OUTPUT_PER_1M,
      }
    : {
        input: env.OPENAI_PRICE_INPUT_PER_1M,
        cachedInput: env.OPENAI_PRICE_CACHED_INPUT_PER_1M,
        output: env.OPENAI_PRICE_OUTPUT_PER_1M,
      };
}

const PER_MILLION = 1_000_000;

export function estimateCost(tier: AiTier, usage: TokenUsage): CostEstimate {
  const prices = pricesFor(tier);
  if (prices.input === undefined || prices.output === undefined) {
    return { costUsd: 0, priced: false, cachedPriceMissing: false };
  }

  // Clamp: a cached count larger than the total would otherwise make the
  // non-cached remainder negative and understate the bill.
  const cached = Math.min(Math.max(usage.cachedInputTokens ?? 0, 0), usage.inputTokens);
  const fullPriceInput = usage.inputTokens - cached;
  const cachedPriceMissing = cached > 0 && prices.cachedInput === undefined;
  const cachedRate = prices.cachedInput ?? prices.input;

  const cost =
    (fullPriceInput / PER_MILLION) * prices.input +
    (cached / PER_MILLION) * cachedRate +
    (usage.outputTokens / PER_MILLION) * prices.output;

  return { costUsd: Number(cost.toFixed(6)), priced: true, cachedPriceMissing };
}

export interface RecordAiCallInput {
  model: string;
  operation: string;
  status: 'succeeded' | 'failed' | 'blocked';
  usage?: TokenUsage;
  tier: AiTier;
  leadId?: string | null;
  conversationId?: string | null;
  jobId?: string | null;
  error?: string | null;
}

export function recordAiCall(input: RecordAiCallInput, db: Db = getDb()): AiCallRow {
  const usage = input.usage ?? { inputTokens: 0, outputTokens: 0 };
  const { costUsd } = estimateCost(input.tier, usage);
  const row: AiCallRow = {
    id: newId('ai'),
    provider: 'openai',
    model: input.model,
    operation: input.operation,
    inputTokens: usage.inputTokens,
    cachedInputTokens: Math.min(Math.max(usage.cachedInputTokens ?? 0, 0), usage.inputTokens),
    outputTokens: usage.outputTokens,
    costUsd,
    status: input.status,
    leadId: input.leadId ?? null,
    conversationId: input.conversationId ?? null,
    jobId: input.jobId ?? null,
    error: input.error ? input.error.slice(0, 1000) : null,
    createdAt: nowIso(),
  };
  db.insert(aiCalls).values(row).run();
  return row;
}

export function monthStartIso(now: Date = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

export interface BudgetStatus {
  spentUsd: number;
  budgetUsd: number;
  remainingUsd: number;
  exceeded: boolean;
  /** Whether the operator has declared prices for both tiers right now. */
  pricesConfigured: boolean;
  /**
   * True when some call this month was recorded with no cost. That is a
   * historical fact about the data, not a statement about the current config:
   * calls made before prices were set stay at zero forever.
   */
  hasUnpricedCalls: boolean;
}

/** Both tiers must be priced for the budget guard to be meaningful. */
export function pricesConfigured(): boolean {
  const reasoning = pricesFor('reasoning');
  const fast = pricesFor('fast');
  return (
    reasoning.input !== undefined &&
    reasoning.output !== undefined &&
    fast.input !== undefined &&
    fast.output !== undefined
  );
}

export function budgetStatus(now: Date = new Date(), db: Db = getDb()): BudgetStatus {
  const since = monthStartIso(now);
  const row = db
    .select({
      spent: sql<number>`coalesce(sum(${aiCalls.costUsd}), 0)`,
      unpriced: sql<number>`sum(case when ${aiCalls.costUsd} = 0 and ${aiCalls.inputTokens} > 0 then 1 else 0 end)`,
    })
    .from(aiCalls)
    .where(gte(aiCalls.createdAt, since))
    .get();
  const budgetUsd = getEnv().OPENAI_MONTHLY_BUDGET_USD;
  const spentUsd = Number(row?.spent ?? 0);
  return {
    spentUsd,
    budgetUsd,
    remainingUsd: Math.max(0, budgetUsd - spentUsd),
    exceeded: budgetUsd > 0 && spentUsd >= budgetUsd,
    pricesConfigured: pricesConfigured(),
    hasUnpricedCalls: Number(row?.unpriced ?? 0) > 0,
  };
}

/** Called before every model request. Pauses the AI capability at the ceiling. */
export function assertBudgetAvailable(db: Db = getDb()): void {
  const status = budgetStatus(new Date(), db);
  if (!status.exceeded) return;
  pauseCapability(
    {
      capability: 'ai_engine',
      reason: `Orçamento mensal de IA atingido (US$ ${status.spentUsd.toFixed(2)} / US$ ${status.budgetUsd.toFixed(2)}).`,
      by: 'system',
      details: { spentUsd: status.spentUsd, budgetUsd: status.budgetUsd },
    },
    db,
  );
  raiseAlert(
    {
      kind: 'budget',
      severity: 'critical',
      code: 'ai_budget_exceeded',
      title: 'Orçamento mensal de IA atingido',
      detail: `Gasto de US$ ${status.spentUsd.toFixed(2)} sobre o teto de US$ ${status.budgetUsd.toFixed(2)}.`,
      dedupeKey: `budget:${monthStartIso()}`,
    },
    db,
  );
  throw new AppError('ai_budget_exceeded', 'Orçamento mensal de IA atingido; novas chamadas bloqueadas.', {
    details: { spentUsd: status.spentUsd, budgetUsd: status.budgetUsd },
  });
}

export function recentAiCalls(limit = 50, db: Db = getDb()): AiCallRow[] {
  return db.select().from(aiCalls).orderBy(desc(aiCalls.createdAt)).limit(limit).all();
}
