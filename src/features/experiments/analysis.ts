import { and, eq } from 'drizzle-orm';
import { getDb, type Db } from '@/db/client';
import { events, experimentAssignments, experiments, experimentVariants } from '@/db/schema';
import type { Funnel, PipelineStage } from '@/features/leads/states';

/**
 * Experiment analysis.
 *
 * Success is measured on the outcome that actually matters commercially, not on
 * replies: the ladders below come straight from the operator's stated
 * priorities. A winner is only declared with enough sample and a two-proportion
 * test that clears the confidence threshold.
 */

export const CUSTOMER_SUCCESS_LADDER: PipelineStage[] = [
  'active_customer',
  'registered',
  'whatsapp_handoff',
  'interested',
  'replied',
];

export const AFFILIATE_SUCCESS_LADDER: PipelineStage[] = [
  'generated_customer',
  'active_affiliate',
  'joined_affiliate_group',
  'interested',
  'replied',
];

export function successLadder(funnel: Funnel): PipelineStage[] {
  return funnel === 'customer' ? CUSTOMER_SUCCESS_LADDER : AFFILIATE_SUCCESS_LADDER;
}

export interface VariantStats {
  variantId: string;
  variantName: string;
  isControl: boolean;
  weight: number;
  assigned: number;
  successes: number;
  rate: number;
}

/** Leads that ever reached `stage`, taken from the immutable event log. */
function leadsThatReached(stage: PipelineStage, db: Db): Set<string> {
  const rows = db
    .select({ leadId: events.leadId, payload: events.payload })
    .from(events)
    .where(eq(events.type, 'lead.stage_changed'))
    .all();
  const reached = new Set<string>();
  for (const row of rows) {
    if (!row.leadId) continue;
    try {
      const payload = JSON.parse(row.payload) as { to?: string };
      if (payload.to === stage) reached.add(row.leadId);
    } catch {
      continue;
    }
  }
  return reached;
}

export interface ExperimentAnalysis {
  experimentId: string;
  primaryMetric: string;
  totalAssigned: number;
  minSampleSize: number;
  variants: VariantStats[];
  verdict: 'insufficient_sample' | 'no_significant_difference' | 'winner';
  winnerVariantId: string | null;
  confidence: number;
}

const Z_FOR_95 = 1.96;

/** Two-proportion z-test; returns the |z| statistic. */
export function twoProportionZ(successesA: number, totalA: number, successesB: number, totalB: number): number {
  if (totalA === 0 || totalB === 0) return 0;
  const rateA = successesA / totalA;
  const rateB = successesB / totalB;
  const pooled = (successesA + successesB) / (totalA + totalB);
  const denominator = Math.sqrt(pooled * (1 - pooled) * (1 / totalA + 1 / totalB));
  if (denominator === 0) return 0;
  return Math.abs((rateA - rateB) / denominator);
}

export function analyzeExperiment(experimentId: string, db: Db = getDb()): ExperimentAnalysis | null {
  const experiment = db.select().from(experiments).where(eq(experiments.id, experimentId)).get();
  if (!experiment) return null;

  const variants = db.select().from(experimentVariants).where(eq(experimentVariants.experimentId, experimentId)).all();
  const successLeads = leadsThatReached(experiment.primaryMetric as PipelineStage, db);

  const stats: VariantStats[] = variants.map((variant) => {
    const assignments = db
      .select({ leadId: experimentAssignments.leadId })
      .from(experimentAssignments)
      .where(and(eq(experimentAssignments.experimentId, experimentId), eq(experimentAssignments.variantId, variant.id)))
      .all();
    const successes = assignments.filter((row) => successLeads.has(row.leadId)).length;
    return {
      variantId: variant.id,
      variantName: variant.name,
      isControl: variant.isControl === 1,
      weight: variant.weight,
      assigned: assignments.length,
      successes,
      rate: assignments.length === 0 ? 0 : successes / assignments.length,
    };
  });

  const totalAssigned = stats.reduce((sum, entry) => sum + entry.assigned, 0);
  const base: ExperimentAnalysis = {
    experimentId,
    primaryMetric: experiment.primaryMetric,
    totalAssigned,
    minSampleSize: experiment.minSampleSize,
    variants: stats,
    verdict: 'insufficient_sample',
    winnerVariantId: null,
    confidence: 0,
  };

  if (totalAssigned < experiment.minSampleSize || stats.length < 2) return base;
  if (stats.some((entry) => entry.assigned < Math.max(10, Math.floor(experiment.minSampleSize / stats.length / 2)))) {
    return base;
  }

  const ordered = [...stats].sort((a, b) => b.rate - a.rate);
  const best = ordered[0];
  const runnerUp = ordered[1];
  if (!best || !runnerUp) return base;

  const z = twoProportionZ(best.successes, best.assigned, runnerUp.successes, runnerUp.assigned);
  if (z < Z_FOR_95) {
    return { ...base, verdict: 'no_significant_difference', confidence: Number((z / Z_FOR_95).toFixed(2)) };
  }

  return { ...base, verdict: 'winner', winnerVariantId: best.variantId, confidence: Number((z / Z_FOR_95).toFixed(2)) };
}
