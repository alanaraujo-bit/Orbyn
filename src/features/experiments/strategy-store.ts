import { eq } from 'drizzle-orm';
import { getDb, type Db } from '@/db/client';
import { strategyState } from '@/db/schema';
import { recordAudit } from '@/lib/audit';
import { nowIso } from '@/lib/time';

/**
 * Learned operational intelligence.
 *
 * This is deliberately a *separate* store from `config/business.json`: official
 * business facts are operator-owned and immutable to the system, while
 * everything the optimizer learns lives here and may evolve freely inside the
 * approved limits.
 */

export type StrategyWriter = 'operator' | 'optimizer' | 'system';

export const STRATEGY_KEYS = [
  'warmup_schedule',
  'icp_keyword_weights',
  'preferred_send_minutes',
  'variant_exposure',
  'discovery_hints',
] as const;

export type StrategyKey = (typeof STRATEGY_KEYS)[number];

export function readStrategy<T>(key: StrategyKey, db: Db = getDb()): T | undefined {
  const row = db.select({ value: strategyState.value }).from(strategyState).where(eq(strategyState.key, key)).get();
  if (!row) return undefined;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return undefined;
  }
}

export function writeStrategy<T>(key: StrategyKey, value: T, by: StrategyWriter, db: Db = getDb()): void {
  const before = readStrategy<T>(key, db);
  const now = nowIso();
  db.insert(strategyState)
    .values({ key, value: JSON.stringify(value), updatedBy: by, updatedAt: now })
    .onConflictDoUpdate({
      target: strategyState.key,
      set: { value: JSON.stringify(value), updatedBy: by, updatedAt: now },
    })
    .run();
  recordAudit(
    {
      actor: by === 'optimizer' ? 'ai' : by,
      action: 'strategy.write',
      entityType: 'strategy_state',
      entityId: key,
      before,
      after: value,
    },
    db,
  );
}

export function listStrategy(db: Db = getDb()): { key: string; value: string; updatedBy: string; updatedAt: string }[] {
  return db.select().from(strategyState).all();
}
