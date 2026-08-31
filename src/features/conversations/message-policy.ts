import { getBusinessConfig } from '@/config/business';
import type { BusinessConfig } from '@/config/schema';

/**
 * Outbound message policy.
 *
 * Nothing leaves the system unless it survives this file. Two independent
 * guards run on every message:
 *
 *  1. Placeholder guard - a lead can never receive "A DEFINIR", `{{token}}` or
 *     an unresolved link.
 *  2. Claim guard - factual statements about the business are only allowed when
 *     they are backed by `verifiedClaims`. Everything shaped like an
 *     unverified claim (numbers, ROI, superlatives, guarantees, invented social
 *     proof or urgency) is rejected regardless of who generated it.
 */

export type ViolationCode =
  | 'placeholder'
  | 'unresolved_template'
  | 'quantified_result'
  | 'superlative'
  | 'invented_social_proof'
  | 'guarantee'
  | 'false_urgency'
  | 'invented_relationship'
  | 'ungrounded_observation'
  | 'too_long'
  | 'empty';

export interface PolicyViolation {
  code: ViolationCode;
  message: string;
  excerpt: string;
}

export interface PolicyResult {
  ok: boolean;
  violations: PolicyViolation[];
}

export const MAX_OUTBOUND_CHARS = 900;

interface Rule {
  code: ViolationCode;
  message: string;
  pattern: RegExp;
}

const PLACEHOLDER_RULES: Rule[] = [
  { code: 'placeholder', message: 'Contém valor não configurado ("A DEFINIR").', pattern: /a\s+definir/i },
  { code: 'unresolved_template', message: 'Contém template não resolvido.', pattern: /\{\{[^}]*\}\}/ },
  { code: 'unresolved_template', message: 'Contém marcador entre colchetes não resolvido.', pattern: /\[[a-zA-Z_ ]{2,30}\]/ },
  { code: 'placeholder', message: 'Contém "undefined"/"null" literal.', pattern: /\b(undefined|null)\b/ },
];

const CLAIM_RULES: Rule[] = [
  {
    code: 'quantified_result',
    message: 'Promete resultado quantitativo sem evidência.',
    pattern: /\d+\s*%|\b\d+x\b|\bROI\b|\breduz(?:imos|iu|ir)\b|\baument(?:amos|ou|ar)\b.*\b\d|\beconomi[az]\b.*\b\d/i,
  },
  {
    code: 'quantified_result',
    message: 'Cita valores financeiros como resultado.',
    pattern: /R\$\s?\d/i,
  },
  {
    code: 'superlative',
    message: 'Usa superlativo ou autoridade de mercado não comprovada.',
    pattern: /\b(l[íi]der|n[úu]mero\s*1|a\s+maior|o\s+maior|melhor\s+(?:do|da|em)|refer[êe]ncia\s+(?:no|na|em)|top\s*1)\b/i,
  },
  {
    code: 'invented_social_proof',
    message: 'Menciona clientes, cases ou depoimentos não documentados.',
    pattern: /\b(?:mais\s+de\s+\d+\s+(?:clientes|empresas)|nossos\s+clientes|centenas\s+de|milhares\s+de|dezenas\s+de|depoimento|case\s+de\s+sucesso)\b/i,
  },
  {
    code: 'guarantee',
    message: 'Oferece garantia de resultado.',
    pattern: /\b(garant(?:o|imos|ia|ido)|prometo|com\s+certeza\s+voc[êe]\s+vai)\b/i,
  },
  {
    code: 'false_urgency',
    message: 'Cria urgência artificial.',
    // No leading \b: JS word boundaries do not fire before accented letters.
    pattern: /(?:[úu]ltim[ao]s?\s+(?:vagas?|dias?|chance)|s[óo]\s+hoje|restam\s+\d|por\s+tempo\s+limitado|\bcorre\b)/i,
  },
  {
    code: 'invented_relationship',
    message: 'Sugere relação ou histórico inexistente.',
    pattern: /\b(?:j[áa]\s+trabalhamos\s+juntos|somos\s+parceiros|nos\s+conhecemos|voc[êe]\s+me\s+indicou|sou\s+seu\s+cliente)\b/i,
  },
];

function excerptFor(text: string, pattern: RegExp): string {
  const match = pattern.exec(text);
  if (!match) return '';
  const start = Math.max(0, match.index - 20);
  return text.slice(start, match.index + match[0].length + 20).trim();
}

function isBackedByVerifiedClaim(text: string, config: BusinessConfig): boolean {
  const normalized = text.toLowerCase();
  return config.verifiedClaims.some((claim) => normalized.includes(claim.toLowerCase()));
}

export function validateOutboundText(text: string, config: BusinessConfig = getBusinessConfig()): PolicyResult {
  const violations: PolicyViolation[] = [];
  const trimmed = text.trim();

  if (trimmed.length === 0) {
    return { ok: false, violations: [{ code: 'empty', message: 'Mensagem vazia.', excerpt: '' }] };
  }
  if (trimmed.length > MAX_OUTBOUND_CHARS) {
    violations.push({
      code: 'too_long',
      message: `Mensagem acima de ${MAX_OUTBOUND_CHARS} caracteres.`,
      excerpt: `${trimmed.length} caracteres`,
    });
  }

  for (const rule of PLACEHOLDER_RULES) {
    if (rule.pattern.test(trimmed)) {
      violations.push({ code: rule.code, message: rule.message, excerpt: excerptFor(trimmed, rule.pattern) });
    }
  }

  for (const rule of CLAIM_RULES) {
    if (!rule.pattern.test(trimmed)) continue;
    // A sentence copied verbatim from verifiedClaims is allowed even if it
    // happens to trip a keyword rule.
    if (isBackedByVerifiedClaim(trimmed, config)) continue;
    violations.push({ code: rule.code, message: rule.message, excerpt: excerptFor(trimmed, rule.pattern) });
  }

  return { ok: violations.length === 0, violations };
}

function contentWords(value: string): string[] {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 3);
}

/**
 * An observation about the lead may only be used when every content word of it
 * actually appears in text we are prepared to treat as a statement about their
 * business. This is what keeps "Vi que vocês trabalham com distribuição de
 * bebidas" legal and "Imagino que vocês percam dinheiro com estoque" out.
 *
 * The licensed text is deliberately narrow. It used to be the whole profile
 * snapshot, which meant any word appearing anywhere licensed a claim built from
 * it - and the snapshot was a raw scrape of the profile header. A distributor
 * whose owner listed "Profissão mecânico" in his personal bio was told "Vi que
 * você trabalha como mecânico": every word of the observation was present, so
 * the check passed, and the claim was still wrong about the business.
 *
 * A word appearing near a business is not a fact about that business. Only a
 * field whose meaning is established may license an assertion about what
 * someone does.
 */
export function validateObservation(observation: string | null, licensedText: string): PolicyResult {
  if (observation === null || observation.trim().length === 0) return { ok: true, violations: [] };
  if (licensedText.trim().length === 0) {
    return {
      ok: false,
      violations: [
        {
          code: 'ungrounded_observation',
          message:
            'Nenhum campo de significado conhecido foi observado neste perfil; nada pode ser afirmado sobre a atividade dele.',
          excerpt: observation.trim().slice(0, 120),
        },
      ],
    };
  }
  const haystack = new Set(contentWords(licensedText));
  const missing = contentWords(observation).filter((word) => !haystack.has(word));
  if (missing.length === 0) return { ok: true, violations: [] };
  return {
    ok: false,
    violations: [
      {
        code: 'ungrounded_observation',
        message: 'A observação cita informação que não está no perfil público coletado.',
        excerpt: missing.join(', '),
      },
    ],
  };
}

/** Flattens everything we actually observed into a single searchable string. */
export function snapshotSearchText(input: {
  handle: string;
  displayName?: string | null;
  bio?: string | null;
  category?: string | null;
  location?: string | null;
  externalUrl?: string | null;
  profileSnapshot?: string | null;
}): string {
  let extra = '';
  if (input.profileSnapshot) {
    try {
      const parsed = JSON.parse(input.profileSnapshot) as { postHashtags?: string[]; postCaptions?: string[] };
      extra = [...(parsed.postHashtags ?? []), ...(parsed.postCaptions ?? [])].join(' ');
    } catch {
      extra = '';
    }
  }
  return [input.handle, input.displayName, input.bio, input.category, input.location, input.externalUrl, extra]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join(' \n ');
}
