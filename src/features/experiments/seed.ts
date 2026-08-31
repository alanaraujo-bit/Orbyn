import { eq } from 'drizzle-orm';
import { getDb, type Db } from '@/db/client';
import { experiments, experimentVariants } from '@/db/schema';
import { newId } from '@/lib/ids';
import { nowIso } from '@/lib/time';
import { recordAudit } from '@/lib/audit';
import type { Funnel } from '@/features/leads/states';

/**
 * Baseline experiment so the system starts measuring from the first DM instead
 * of collecting unattributed traffic. Only the *style* of the opener varies -
 * the factual content is bounded by the message policy either way.
 */

export interface SeedVariant {
  name: string;
  guidance: string;
  isControl: boolean;
}

export interface SeedExperimentInput {
  name: string;
  hypothesis: string;
  funnel: Funnel;
  scope: 'opener' | 'presentation' | 'value_prop' | 'cta' | 'followup';
  primaryMetric: string;
  minSampleSize?: number;
  variants: SeedVariant[];
}

export function ensureExperiment(input: SeedExperimentInput, db: Db = getDb()): string {
  const existing = db.select().from(experiments).where(eq(experiments.name, input.name)).get();
  if (existing) return existing.id;

  const now = nowIso();
  const id = newId('exp');
  db.insert(experiments)
    .values({
      id,
      name: input.name,
      hypothesis: input.hypothesis,
      funnel: input.funnel,
      scope: input.scope,
      status: 'running',
      primaryMetric: input.primaryMetric,
      minSampleSize: input.minSampleSize ?? 60,
      explorationRate: 0.1,
      analysisWindowDays: 14,
      startedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .run();

  for (const variant of input.variants) {
    db.insert(experimentVariants)
      .values({
        id: newId('var'),
        experimentId: id,
        name: variant.name,
        isControl: variant.isControl ? 1 : 0,
        weight: 1 / input.variants.length,
        guidance: variant.guidance,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }

  recordAudit(
    { actor: 'operator', action: 'experiment.create', entityType: 'experiment', entityId: id, after: { name: input.name } },
    db,
  );
  return id;
}

export const DEFAULT_OPENER_EXPERIMENT: SeedExperimentInput = {
  name: 'abertura-cliente-v1',
  hypothesis:
    'Uma abertura que cita algo concreto observado no perfil gera mais respostas do que uma abertura neutra.',
  funnel: 'customer',
  scope: 'opener',
  // An opener can cause a reply; it cannot plausibly cause a WhatsApp handoff
  // on its own, since everything between the two is a different conversation.
  // Measuring the terminal stage here diluted the effect and pushed the sample
  // out by weeks. Later stages belong to experiments on the scopes that drive
  // them.
  primaryMetric: 'replied',
  minSampleSize: 60,
  variants: [
    {
      name: 'controle-neutro',
      isControl: true,
      guidance:
        'Abertura neutra: cumprimente, apresente-se em uma frase e pergunte como a operação da empresa é controlada hoje. Não comente o conteúdo do perfil.',
    },
    {
      name: 'observacao-concreta',
      isControl: false,
      guidance:
        'Abertura contextual: comente uma informação concreta e verdadeira observada no perfil antes de fazer a pergunta. Se não houver nada concreto, use uma abertura neutra.',
    },
  ],
};

export function ensureDefaultExperiments(db: Db = getDb()): void {
  ensureExperiment(DEFAULT_OPENER_EXPERIMENT, db);
}
