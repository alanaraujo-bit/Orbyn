import { eq } from 'drizzle-orm';
import { getDb, type Db } from '@/db/client';
import { experiments, experimentVariants } from '@/db/schema';
import { nowIso } from '@/lib/time';
import { recordAudit, recordEvent } from '@/lib/audit';
import { createLogger } from '@/lib/logger';
import { analyzeExperiment } from './analysis';
import { writeStrategy } from './strategy-store';

const log = createLogger('optimizer');

/**
 * Autonomous optimisation, inside hard limits.
 *
 * The optimizer may reweight message variants, re-rank discovery terms and
 * reweight ICP keywords. It may not touch `config/business.json`, operator
 * ceilings, safety policy, pricing or claims - those live outside this module
 * by construction.
 *
 * Every loop here is gated on its own evidence and refuses to act below it.
 * Acting on a handful of leads would not be learning, only amplified noise -
 * and unlike a variant weight, a keyword weight changes who gets messaged.
 */

/** Maximum share a single variant may take, so exploration never dies out. */
export const MAX_VARIANT_WEIGHT = 0.85;
export const MIN_EXPLORATION_WEIGHT = 0.05;
/** How fast weights may move in a single optimisation pass. */
export const MAX_WEIGHT_STEP = 0.15;

export interface OptimizationOutcome {
  experimentId: string;
  experimentName: string;
  action: 'unchanged' | 'reweighted' | 'winner_declared';
  detail: string;
}

export function optimizeExperiments(db: Db = getDb()): OptimizationOutcome[] {
  const running = db.select().from(experiments).where(eq(experiments.status, 'running')).all();
  const outcomes: OptimizationOutcome[] = [];

  for (const experiment of running) {
    const analysis = analyzeExperiment(experiment.id, db);
    if (!analysis) continue;

    if (analysis.verdict === 'insufficient_sample') {
      outcomes.push({
        experimentId: experiment.id,
        experimentName: experiment.name,
        action: 'unchanged',
        detail: `Amostra insuficiente (${analysis.totalAssigned}/${analysis.minSampleSize}).`,
      });
      continue;
    }

    if (analysis.verdict === 'no_significant_difference') {
      outcomes.push({
        experimentId: experiment.id,
        experimentName: experiment.name,
        action: 'unchanged',
        detail: `Sem diferença significativa (confiança ${analysis.confidence}).`,
      });
      continue;
    }

    const winnerId = analysis.winnerVariantId;
    if (!winnerId) continue;

    const variants = analysis.variants;
    const totalWeight = variants.reduce((sum, variant) => sum + variant.weight, 0) || 1;
    const updates = variants.map((variant) => {
      const current = variant.weight / totalWeight;
      const target = variant.variantId === winnerId ? MAX_VARIANT_WEIGHT : MIN_EXPLORATION_WEIGHT;
      const step = Math.max(-MAX_WEIGHT_STEP, Math.min(MAX_WEIGHT_STEP, target - current));
      const next = Math.max(MIN_EXPLORATION_WEIGHT, Math.min(MAX_VARIANT_WEIGHT, current + step));
      return { variantId: variant.variantId, from: Number(current.toFixed(3)), to: Number(next.toFixed(3)) };
    });

    for (const update of updates) {
      db.update(experimentVariants)
        .set({ weight: update.to, updatedAt: nowIso() })
        .where(eq(experimentVariants.id, update.variantId))
        .run();
    }

    db.update(experiments)
      .set({ winnerVariantId: winnerId, updatedAt: nowIso() })
      .where(eq(experiments.id, experiment.id))
      .run();

    writeStrategy('variant_exposure', { experimentId: experiment.id, updates }, 'optimizer', db);
    recordAudit(
      {
        actor: 'ai',
        action: 'experiment.reweight',
        entityType: 'experiment',
        entityId: experiment.id,
        after: { winnerVariantId: winnerId, updates },
        reason: `confiança ${analysis.confidence}`,
      },
      db,
    );
    recordEvent(
      {
        type: 'experiment.winner_declared',
        experimentId: experiment.id,
        variantId: winnerId,
        payload: { confidence: analysis.confidence, updates },
      },
      db,
    );

    outcomes.push({
      experimentId: experiment.id,
      experimentName: experiment.name,
      action: 'winner_declared',
      detail: `Variante vencedora com confiança ${analysis.confidence}; exposição ajustada gradualmente.`,
    });
  }

  log.info('optimization pass finished', { experiments: outcomes.length });
  return outcomes;
}
