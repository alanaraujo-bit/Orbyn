import { getBusinessConfig } from '@/config/business';
import type { BusinessConfig } from '@/config/schema';
import type { Funnel, Persona } from './states';

/**
 * ICP scoring. The official ICP definition always comes from
 * `config/business.json`; learned weights only re-rank inside that definition
 * and are stored separately in `strategy_state`.
 */

export interface PublicProfileSignals {
  handle: string;
  displayName?: string | null;
  bio?: string | null;
  category?: string | null;
  location?: string | null;
  externalUrl?: string | null;
  followersCount?: number | null;
  /** Hashtags and captions actually observed on public posts. */
  postHashtags?: string[];
  postCaptions?: string[];
  isBusinessAccount?: boolean | null;
}

export interface ScoreSignal {
  key: string;
  label: string;
  weight: number;
  matched: string[];
}

export interface ScoreResult {
  score: number;
  persona: Persona;
  niche: string | null;
  signals: ScoreSignal[];
  matchedKeywords: string[];
}

/** Learned multipliers per keyword, produced by the optimizer. Defaults to 1. */
export type LearnedKeywordWeights = Readonly<Record<string, number>>;

const OWNER_MARKERS = ['ceo', 'fundador', 'fundadora', 'proprietário', 'proprietaria', 'proprietário(a)', 'dono', 'dona', 'sócio', 'socio', 'diretor', 'diretora', 'gestor', 'gestora'];
const STORE_MARKERS = ['loja', 'distribuidora', 'comércio', 'comercio', 'atacado', 'varejo', 'mercado', 'depósito', 'deposito', 'revenda', 'empresa', 'ltda', 'me ', 'oficial'];
const EMPLOYEE_MARKERS = ['vendedor', 'vendedora', 'atendente', 'consultor de vendas', 'estagiário', 'estagiaria'];

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '');
}

function haystack(profile: PublicProfileSignals): string {
  return normalizeText(
    [
      profile.handle,
      profile.displayName ?? '',
      profile.bio ?? '',
      profile.category ?? '',
      profile.location ?? '',
      profile.externalUrl ?? '',
      ...(profile.postHashtags ?? []),
      ...(profile.postCaptions ?? []),
    ].join(' \n '),
  );
}

function matchTerms(text: string, terms: readonly string[]): string[] {
  const found: string[] = [];
  for (const term of terms) {
    const normalized = normalizeText(term);
    if (normalized.length > 0 && text.includes(normalized)) found.push(term);
  }
  return found;
}

export function detectPersona(profile: PublicProfileSignals): Persona {
  const text = haystack(profile);
  if (matchTerms(text, OWNER_MARKERS).length > 0) return 'decision_maker';
  if (matchTerms(text, EMPLOYEE_MARKERS).length > 0) return 'employee';
  if (profile.isBusinessAccount === true || matchTerms(text, STORE_MARKERS).length > 0) return 'store';
  return 'unknown';
}

function detectNiche(profile: PublicProfileSignals, config: BusinessConfig): string | null {
  if (profile.category && profile.category.trim().length > 0) return profile.category.trim();
  const text = haystack(profile);
  const segment = config.icp.segments.find((entry) =>
    normalizeText(entry)
      .split(/[\s,]+/)
      .filter((word) => word.length > 5)
      .some((word) => text.includes(word)),
  );
  return segment ?? null;
}

export interface ScoreOptions {
  config?: BusinessConfig;
  learnedWeights?: LearnedKeywordWeights;
}

const MAX_RAW_SCORE = 100;

export function scoreLead(profile: PublicProfileSignals, funnel: Funnel, options: ScoreOptions = {}): ScoreResult {
  const config = options.config ?? getBusinessConfig();
  const weights = options.learnedWeights ?? {};
  const text = haystack(profile);
  const signals: ScoreSignal[] = [];

  const topicTerms = funnel === 'customer' ? config.icp.keywords : config.affiliateProgram.topics;
  const matchedKeywords = matchTerms(text, topicTerms);
  const keywordWeight = matchedKeywords.reduce((total, keyword) => total + 12 * (weights[keyword] ?? 1), 0);
  if (matchedKeywords.length > 0) {
    signals.push({
      key: 'icp_keywords',
      label: funnel === 'customer' ? 'Palavras-chave do ICP' : 'Temas do programa de afiliados',
      weight: Math.min(keywordWeight, 45),
      matched: matchedKeywords,
    });
  }

  const matchedSegments = funnel === 'customer' ? matchSegments(text, config) : [];
  if (matchedSegments.length > 0) {
    signals.push({
      key: 'icp_segments',
      label: 'Segmento do ICP',
      weight: Math.min(matchedSegments.length * 12, 24),
      matched: matchedSegments,
    });
  }

  const persona = detectPersona(profile);
  const personaWeight: Record<Persona, number> = {
    decision_maker: 20,
    owner: 18,
    store: 12,
    unknown: 0,
    employee: -10,
  };
  if (personaWeight[persona] !== 0) {
    signals.push({ key: 'persona', label: 'Perfil do interlocutor', weight: personaWeight[persona], matched: [persona] });
  }

  const geography = normalizeText(config.geography);
  const locationMatch = profile.location ? normalizeText(profile.location).includes(geography) : false;
  if (locationMatch) {
    signals.push({ key: 'geography', label: 'Localização pública compatível', weight: 8, matched: [config.geography] });
  }

  if (profile.isBusinessAccount === true) {
    signals.push({ key: 'business_account', label: 'Conta comercial', weight: 6, matched: ['business_account'] });
  }

  if (profile.externalUrl && profile.externalUrl.trim().length > 0) {
    signals.push({ key: 'website', label: 'Site público informado', weight: 4, matched: [profile.externalUrl] });
  }

  if (funnel === 'affiliate') {
    const followers = profile.followersCount ?? 0;
    const audienceWeight = followers >= 5_000 ? 18 : followers >= 1_000 ? 10 : followers > 0 ? 4 : 0;
    if (audienceWeight > 0) {
      signals.push({ key: 'audience', label: 'Tamanho de audiência pública', weight: audienceWeight, matched: [String(followers)] });
    }
  }

  const raw = signals.reduce((total, signal) => total + signal.weight, 0);
  const score = Math.max(0, Math.min(MAX_RAW_SCORE, Math.round(raw)));

  return { score, persona, niche: detectNiche(profile, config), signals, matchedKeywords };
}

/** Longest prefix we compare on: short enough to survive inflection, long
 * enough that "comerci" cannot be reached by an unrelated word. */
const SEGMENT_STEM_LENGTH = 7;

/**
 * Matches a profile against the ICP segments.
 *
 * The segments are prose ("Comércios, distribuidores e empresas que precisam
 * digitalizar sua operação"), while a real prospect writes "J.A DISTRIBUIDORA".
 * Comparing whole words made the plural in the segment miss the singular in the
 * bio, so actual clients scored below the qualification threshold while a
 * competitor whose bio spoke corporate vocabulary scored above it - the signal
 * pointed the wrong way. Comparing stems fixes the inflection mismatch without
 * loosening the match to arbitrary substrings.
 */
function matchSegments(text: string, config: BusinessConfig): string[] {
  return config.icp.segments.filter((segment) =>
    normalizeText(segment)
      .split(/[\s,]+/)
      .filter((word) => word.length > 6)
      .some((word) => text.includes(word.slice(0, SEGMENT_STEM_LENGTH))),
  );
}

/** Priority buckets drive the outreach queue ordering. */
export function priorityForScore(score: number): number {
  if (score >= 70) return 3;
  if (score >= 50) return 2;
  if (score >= 30) return 1;
  return 0;
}

export const QUALIFICATION_THRESHOLD = 40;

export function qualifies(score: number): boolean {
  return score >= QUALIFICATION_THRESHOLD;
}
