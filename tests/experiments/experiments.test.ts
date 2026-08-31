import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { withTestDatabase } from '../helpers/db';
import { makeLead } from '../helpers/factories';
import { getDb } from '@/db/client';
import { experimentVariants } from '@/db/schema';
import { ensureExperiment, DEFAULT_OPENER_EXPERIMENT } from '@/features/experiments/seed';
import { assignVariant, pickVariant } from '@/features/experiments/assignment';
import { analyzeExperiment, twoProportionZ } from '@/features/experiments/analysis';
import { optimizeExperiments, MAX_WEIGHT_STEP, MIN_EXPLORATION_WEIGHT } from '@/features/experiments/optimizer';
import { transitionStage } from '@/features/leads/repository';
import type { PipelineStage } from '@/features/leads/states';

withTestDatabase();

function walkTo(leadId: string, stages: PipelineStage[]): void {
  for (const stage of stages) transitionStage({ leadId, to: stage, actor: 'system' });
}

describe('variant assignment', () => {
  it('assigns a variant and keeps it stable for the lead', () => {
    ensureExperiment(DEFAULT_OPENER_EXPERIMENT);
    const lead = makeLead();

    const first = assignVariant(lead.id, 'customer', 'opener');
    const second = assignVariant(lead.id, 'customer', 'opener');

    expect(first).not.toBeNull();
    expect(second?.variantId).toBe(first?.variantId);
  });

  it('returns null when no experiment is running for the scope', () => {
    expect(assignVariant('lead_x', 'customer', 'cta')).toBeNull();
  });

  it('respects the configured weights', () => {
    const variants = [
      { id: 'a', weight: 0.9 },
      { id: 'b', weight: 0.1 },
    ] as Parameters<typeof pickVariant>[0];
    expect(pickVariant(variants, 0.1)?.id).toBe('a');
    expect(pickVariant(variants, 0.99)?.id).toBe('b');
  });
});

describe('analysis', () => {
  it('refuses to declare a winner without enough sample', () => {
    const experimentId = ensureExperiment({ ...DEFAULT_OPENER_EXPERIMENT, minSampleSize: 40 });
    for (let index = 0; index < 6; index += 1) {
      const lead = makeLead();
      assignVariant(lead.id, 'customer', 'opener');
    }
    const analysis = analyzeExperiment(experimentId);
    expect(analysis?.verdict).toBe('insufficient_sample');
    expect(analysis?.winnerVariantId).toBeNull();
  });

  it('computes a z statistic that grows with the difference', () => {
    expect(twoProportionZ(10, 100, 10, 100)).toBe(0);
    expect(twoProportionZ(40, 100, 10, 100)).toBeGreaterThan(1.96);
  });

  it('declares a winner only when the difference clears the threshold', () => {
    const experimentId = ensureExperiment({ ...DEFAULT_OPENER_EXPERIMENT, minSampleSize: 40 });
    const variants = getDb().select().from(experimentVariants).where(eq(experimentVariants.experimentId, experimentId)).all();
    const [control, challenger] = variants;
    if (!control || !challenger) throw new Error('unreachable');

    // Force a deterministic split: 30 leads per variant, 2/30 vs 20/30 reaching
    // the primary metric.
    for (let index = 0; index < 30; index += 1) {
      const lead = makeLead();
      assignVariant(lead.id, 'customer', 'opener', getDb(), 0.01);
      if (index < 2) walkTo(lead.id, ['contacted', 'replied', 'interested', 'whatsapp_handoff']);
    }
    for (let index = 0; index < 30; index += 1) {
      const lead = makeLead();
      assignVariant(lead.id, 'customer', 'opener', getDb(), 0.99);
      if (index < 20) walkTo(lead.id, ['contacted', 'replied', 'interested', 'whatsapp_handoff']);
    }

    const analysis = analyzeExperiment(experimentId);
    expect(analysis?.verdict).toBe('winner');
    expect(analysis?.winnerVariantId).toBe(challenger.id);
    expect(analysis?.confidence).toBeGreaterThanOrEqual(1);
  });
});

describe('optimizer', () => {
  it('moves exposure gradually and always keeps room to explore', () => {
    const experimentId = ensureExperiment({ ...DEFAULT_OPENER_EXPERIMENT, minSampleSize: 40 });
    for (let index = 0; index < 30; index += 1) {
      const lead = makeLead();
      assignVariant(lead.id, 'customer', 'opener', getDb(), 0.01);
    }
    for (let index = 0; index < 30; index += 1) {
      const lead = makeLead();
      assignVariant(lead.id, 'customer', 'opener', getDb(), 0.99);
      if (index < 20) walkTo(lead.id, ['contacted', 'replied', 'interested', 'whatsapp_handoff']);
    }

    const before = getDb().select().from(experimentVariants).where(eq(experimentVariants.experimentId, experimentId)).all();
    const outcomes = optimizeExperiments();
    const after = getDb().select().from(experimentVariants).where(eq(experimentVariants.experimentId, experimentId)).all();

    expect(outcomes[0]?.action).toBe('winner_declared');
    for (const variant of after) {
      const previous = before.find((entry) => entry.id === variant.id);
      expect(variant.weight).toBeGreaterThanOrEqual(MIN_EXPLORATION_WEIGHT);
      expect(Math.abs(variant.weight - (previous?.weight ?? 0))).toBeLessThanOrEqual(MAX_WEIGHT_STEP + 0.001);
    }
  });

  it('changes nothing while the sample is too small', () => {
    ensureExperiment({ ...DEFAULT_OPENER_EXPERIMENT, minSampleSize: 100 });
    const outcomes = optimizeExperiments();
    expect(outcomes[0]?.action).toBe('unchanged');
  });
});
