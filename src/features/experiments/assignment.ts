import { and, eq } from 'drizzle-orm';
import { getDb, type Db } from '@/db/client';
import { experimentAssignments, experiments, experimentVariants, type ExperimentVariantRow } from '@/db/schema';
import { newId } from '@/lib/ids';
import { nowIso } from '@/lib/time';
import { recordEvent } from '@/lib/audit';
import type { Funnel } from '@/features/leads/states';

export type ExperimentScope = 'opener' | 'presentation' | 'value_prop' | 'cta' | 'followup';

export interface VariantAssignment {
  experimentId: string;
  experimentName: string;
  variantId: string;
  variantName: string;
  guidance: string;
  isControl: boolean;
}

/** Weighted pick; the caller is responsible for persisting the assignment. */
export function pickVariant(variants: ExperimentVariantRow[], random: number): ExperimentVariantRow | undefined {
  const usable = variants.filter((variant) => variant.weight > 0);
  if (usable.length === 0) return undefined;
  const total = usable.reduce((sum, variant) => sum + variant.weight, 0);
  let cursor = random * total;
  for (const variant of usable) {
    cursor -= variant.weight;
    if (cursor <= 0) return variant;
  }
  return usable[usable.length - 1];
}

/**
 * Assigns a lead to one variant of the running experiment for a scope. The
 * assignment is sticky: a lead never switches variant mid-conversation, which
 * is what makes the measurement comparable.
 */
export function assignVariant(
  leadId: string,
  funnel: Funnel,
  scope: ExperimentScope,
  db: Db = getDb(),
  random: number = Math.random(),
): VariantAssignment | null {
  const experiment = db
    .select()
    .from(experiments)
    .where(and(eq(experiments.funnel, funnel), eq(experiments.scope, scope), eq(experiments.status, 'running')))
    .get();
  if (!experiment) return null;

  const variants = db.select().from(experimentVariants).where(eq(experimentVariants.experimentId, experiment.id)).all();
  if (variants.length === 0) return null;

  const existing = db
    .select()
    .from(experimentAssignments)
    .where(and(eq(experimentAssignments.experimentId, experiment.id), eq(experimentAssignments.leadId, leadId)))
    .get();

  const variant = existing
    ? variants.find((candidate) => candidate.id === existing.variantId)
    : pickVariant(variants, random);
  if (!variant) return null;

  if (!existing) {
    db.insert(experimentAssignments)
      .values({
        id: newId('asg'),
        experimentId: experiment.id,
        variantId: variant.id,
        leadId,
        assignedAt: nowIso(),
      })
      .onConflictDoNothing()
      .run();
    recordEvent(
      {
        type: 'experiment.assigned',
        funnel,
        leadId,
        experimentId: experiment.id,
        variantId: variant.id,
        payload: { scope, variant: variant.name },
      },
      db,
    );
  }

  return {
    experimentId: experiment.id,
    experimentName: experiment.name,
    variantId: variant.id,
    variantName: variant.name,
    guidance: variant.guidance,
    isControl: variant.isControl === 1,
  };
}

export const DEFAULT_OPENER_GUIDANCE =
  'Abertura curta e direta: cumprimente, comente algo verdadeiro observado no perfil e faça uma pergunta sobre a operação.';
