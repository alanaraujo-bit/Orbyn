import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb, type Db } from '@/db/client';
import { leads, type LeadRow } from '@/db/schema';
import { AppError } from '@/lib/errors';
import { createLogger } from '@/lib/logger';
import { nowIso } from '@/lib/time';
import { recordEvent } from '@/lib/audit';
import { isCapabilityUsable } from '@/features/system/capabilities';
import { callStructured } from '@/integrations/openai/client';
import { validateObservation } from '@/features/conversations/message-policy';

const log = createLogger('profile-study');

/**
 * Establishing what a business does, before writing to it.
 *
 * The system used to contact a profile knowing only a scraped page header, and
 * it showed: a beverage distributor was told "Vi que você trabalha como
 * mecânico" because a line of the owner's personal bio was in the blob. The
 * words were real; the understanding was absent.
 *
 * This is the understanding step. It reads the account's own published
 * evidence - the canonical bio and the captions it wrote on its own posts - and
 * has to come back with a short statement of the activity, quoted from that
 * evidence. When the evidence does not establish one, it says so, and the lead
 * is not contacted at all. Not contacted, rather than contacted with a neutral
 * message: "conhecer antes de mandar" means silence is the correct output for a
 * profile we could not read, and a neutral opener to a stranger is still a
 * message to a stranger.
 */

export interface ProfileStudy {
  /** Short statement of what the business does, copied from the evidence. */
  activity: string | null;
  /** The exact snippets the statement came from. */
  evidence: string[];
  /** Why no activity could be established, when that is the outcome. */
  reason: string | null;
  studiedAt: string;
}

const studySchema = z.object({
  activity: z.string().nullable(),
  evidence: z.array(z.string()).max(4),
  reason: z.string().nullable(),
});

const studyJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    activity: { type: ['string', 'null'] },
    evidence: { type: 'array', items: { type: 'string' }, maxItems: 4 },
    reason: { type: ['string', 'null'] },
  },
  required: ['activity', 'evidence', 'reason'],
};

const INSTRUCTIONS = [
  'Você analisa um perfil público do Instagram para determinar, com evidência, a atividade comercial da conta.',
  '',
  'Responda "activity" com uma expressão curta (2 a 6 palavras) descrevendo o que o NEGÓCIO faz — por exemplo "distribuidora de gás e água" ou "materiais de construção".',
  'Cada palavra de "activity" DEVE aparecer literalmente no bloco de EVIDÊNCIA. Não reescreva, não traduza, não sinônimos. Copie os termos como estão.',
  'Em "evidence", cite os trechos exatos da evidência que sustentam a resposta.',
  '',
  'Responda activity = null, com "reason" explicando, quando:',
  '- a evidência for insuficiente, vazia ou genérica demais;',
  '- for uma conta pessoal, e não um negócio;',
  '- a bio misturar profissão pessoal com o nome do negócio de forma que você não consiga determinar a atividade da empresa com segurança;',
  '- houver qualquer dúvida real.',
  '',
  'Responder null é o resultado correto e esperado com frequência. Nunca deduza a atividade a partir do nome da conta sozinho, e nunca infira a profissão de uma pessoa.',
].join('\n');

/** Everything the account itself published, and nothing we inferred. */
export function studyEvidenceText(lead: LeadRow): string {
  const snapshot = safeSnapshot(lead);
  return [lead.bio ?? '', lead.category ?? '', ...(snapshot.postCaptions ?? []), ...(snapshot.postHashtags ?? [])]
    .filter((entry) => entry.trim().length > 0)
    .join('\n');
}

interface Snapshot {
  postCaptions?: string[];
  postHashtags?: string[];
  study?: ProfileStudy;
  [key: string]: unknown;
}

function safeSnapshot(lead: LeadRow): Snapshot {
  try {
    return JSON.parse(lead.profileSnapshot) as Snapshot;
  } catch {
    return {};
  }
}

export function storedStudy(lead: LeadRow): ProfileStudy | null {
  return safeSnapshot(lead).study ?? null;
}

function persist(lead: LeadRow, study: ProfileStudy, db: Db): void {
  const snapshot = safeSnapshot(lead);
  db.update(leads)
    .set({ profileSnapshot: JSON.stringify({ ...snapshot, study }), updatedAt: nowIso() })
    .where(eq(leads.id, lead.id))
    .run();
  recordEvent(
    {
      type: 'lead.studied',
      funnel: lead.funnel,
      leadId: lead.id,
      payload: { activity: study.activity, reason: study.reason },
    },
    db,
  );
}

/**
 * Reads the profile and records what could be established about it.
 *
 * Idempotent: a lead already studied is not paid for again, so re-qualifying
 * costs nothing.
 */
export async function studyProfile(lead: LeadRow, db: Db = getDb()): Promise<ProfileStudy> {
  const existing = storedStudy(lead);
  if (existing) return existing;

  const evidence = studyEvidenceText(lead);
  if (evidence.trim().length === 0) {
    const study: ProfileStudy = {
      activity: null,
      evidence: [],
      reason: 'Nenhuma evidência pública foi coletada deste perfil.',
      studiedAt: nowIso(),
    };
    persist(lead, study, db);
    return study;
  }

  if (!isCapabilityUsable('ai_engine', db)) {
    // Instagram's own category is a field of known meaning, so it establishes
    // the activity without a model. Without one, the honest answer is "not yet
    // assessed" - the lead waits for the engine to come back rather than being
    // closed for a shortage on our side.
    const category = lead.category?.trim();
    if (!category) {
      throw new AppError('capability_disabled', 'Motor de IA indisponível e nenhuma categoria pública para avaliar o perfil.', {
        deferral: true,
        details: { leadId: lead.id },
      });
    }
    const study: ProfileStudy = {
      activity: category,
      evidence: [category],
      reason: null,
      studiedAt: nowIso(),
    };
    persist(lead, study, db);
    return study;
  }

  const result = await callStructured({
    tier: 'fast',
    operation: 'study_profile',
    schemaName: 'profile_study',
    jsonSchema: studyJsonSchema as unknown as Record<string, unknown>,
    parser: studySchema,
    instructions: INSTRUCTIONS,
    input: ['EVIDÊNCIA PÚBLICA OBSERVADA:', evidence].join('\n'),
    leadId: lead.id,
    maxOutputTokens: 300,
  });

  let activity = result.data.activity?.trim() || null;
  let reason = result.data.reason;

  // The model may only restate the evidence, never extend it. This is the same
  // grounding rule the opener obeys, applied one step earlier so an ungrounded
  // reading never becomes the basis for contacting someone.
  if (activity !== null) {
    const grounding = validateObservation(activity, evidence);
    if (!grounding.ok) {
      log.warn('study rejected: activity not grounded in evidence', { leadId: lead.id, activity });
      reason = `Atividade proposta não está na evidência pública (${grounding.violations[0]?.excerpt ?? ''}).`;
      activity = null;
    }
  }

  const study: ProfileStudy = {
    activity,
    evidence: result.data.evidence.slice(0, 4),
    reason: activity === null ? (reason ?? 'Evidência insuficiente.') : null,
    studiedAt: nowIso(),
  };
  persist(lead, study, db);
  return study;
}

