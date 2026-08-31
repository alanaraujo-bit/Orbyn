import { getDb, type Db } from '@/db/client';
import { leads } from '@/db/schema';
import { getBusinessConfig } from '@/config/business';
import { createLogger } from '@/lib/logger';
import { leadsThatReached } from './analysis';
import { readStrategy, writeStrategy } from './strategy-store';

const log = createLogger('keyword-learning');

/**
 * What the system learns about its own search terms.
 *
 * Two loops, fed by deliberately different signals:
 *
 *  - Discovery ranking learns from the *qualification* rate: does this term
 *    surface profiles that match the ICP at all? That is available early and
 *    only decides which terms are searched first.
 *  - ICP keyword weights learn from the *reply* rate: of the people we actually
 *    contacted, who answered? This one must never be fed by our own scores.
 *    Weighting a keyword by the ICP score of the leads it produced, when that
 *    weight then multiplies the same keyword's contribution to that score, is a
 *    self-amplifying loop: a term that scores high gets weighted up, which makes
 *    it score higher still, with no contact with reality. Replies come from
 *    outside the system and cannot be talked into existence.
 *
 * Neither loop may touch `config/business.json`. The official ICP keyword list
 * is the boundary: these re-rank inside it and adjust weights within a clamp.
 */

/** A term needs this many discovered leads before its rate means anything. */
export const MIN_LEADS_FOR_RANKING = 10;
/** Weights move real scores, so they need contacted leads, not just found ones. */
export const MIN_CONTACTED_FOR_WEIGHTS = 15;
/** How far a learned weight may pull a keyword's contribution. */
export const MIN_KEYWORD_WEIGHT = 0.6;
export const MAX_KEYWORD_WEIGHT = 1.4;
/**
 * Learned signal is applied at half strength. The official ICP is the operator's
 * statement of who the customer is; observation refines it, never overrides it.
 */
export const LEARNING_DAMPENING = 0.5;

export interface KeywordStats {
  keyword: string;
  discovered: number;
  qualified: number;
  contacted: number;
  replied: number;
  /** Share of discovered leads that cleared the ICP threshold. */
  qualificationRate: number;
  /** Share of contacted leads that answered. */
  replyRate: number;
}

export function keywordPerformance(db: Db = getDb()): KeywordStats[] {
  const rows = db.select({ id: leads.id, keyword: leads.sourceKeyword }).from(leads).all();
  const everQualified = leadsThatReached('qualified', db);
  const everContacted = leadsThatReached('contacted', db);
  const everReplied = leadsThatReached('replied', db);

  const buckets = new Map<string, KeywordStats>();
  for (const row of rows) {
    if (!row.keyword) continue;
    const entry = buckets.get(row.keyword) ?? {
      keyword: row.keyword,
      discovered: 0,
      qualified: 0,
      contacted: 0,
      replied: 0,
      qualificationRate: 0,
      replyRate: 0,
    };
    entry.discovered += 1;
    if (everQualified.has(row.id)) entry.qualified += 1;
    if (everContacted.has(row.id)) entry.contacted += 1;
    if (everReplied.has(row.id)) entry.replied += 1;
    buckets.set(row.keyword, entry);
  }

  for (const entry of buckets.values()) {
    entry.qualificationRate = entry.discovered === 0 ? 0 : entry.qualified / entry.discovered;
    entry.replyRate = entry.contacted === 0 ? 0 : entry.replied / entry.contacted;
  }
  return [...buckets.values()].sort((a, b) => b.discovered - a.discovered);
}

export interface LearningOutcome {
  action: 'unchanged' | 'written';
  detail: string;
}

/**
 * Re-ranks the official ICP keywords by how often they surface leads that
 * qualify. Terms without enough evidence keep the operator's order.
 */
export function learnDiscoveryRanking(db: Db = getDb()): LearningOutcome {
  const official = getBusinessConfig().icp.keywords;
  const stats = new Map(keywordPerformance(db).map((entry) => [entry.keyword, entry]));

  const proven = official
    .filter((keyword) => (stats.get(keyword)?.discovered ?? 0) >= MIN_LEADS_FOR_RANKING)
    .sort((a, b) => (stats.get(b)?.qualificationRate ?? 0) - (stats.get(a)?.qualificationRate ?? 0));

  if (proven.length < 2) {
    return {
      action: 'unchanged',
      detail: `Ranking de descoberta: ${proven.length} termo(s) com ${MIN_LEADS_FOR_RANKING}+ leads; ordem oficial mantida.`,
    };
  }

  // Only proven terms are ranked. The reader keeps every official keyword and
  // sends unranked ones to the end, so nothing is dropped from the ICP: a term
  // can lose priority, never its place in the search.
  const previous = readStrategy<{ ranking?: string[] }>('discovery_hints', db)?.ranking ?? [];
  if (previous.length === proven.length && previous.every((term, index) => term === proven[index])) {
    return { action: 'unchanged', detail: 'Ranking de descoberta já refletia a evidência atual.' };
  }

  writeStrategy('discovery_hints', { ranking: proven }, 'optimizer', db);
  return { action: 'written', detail: `Ranking de descoberta atualizado: ${proven.join(' > ')}.` };
}

/**
 * Reweights ICP keywords by the reply rate of the leads they produced, at half
 * strength and inside a clamp.
 */
export function learnIcpKeywordWeights(db: Db = getDb()): LearningOutcome {
  const official = getBusinessConfig().icp.keywords;
  const stats = new Map(keywordPerformance(db).map((entry) => [entry.keyword, entry]));

  const eligible = official.filter((keyword) => (stats.get(keyword)?.contacted ?? 0) >= MIN_CONTACTED_FOR_WEIGHTS);
  if (eligible.length < 2) {
    return {
      action: 'unchanged',
      detail: `Pesos de ICP: ${eligible.length} termo(s) com ${MIN_CONTACTED_FOR_WEIGHTS}+ contatados; pesos mantidos em 1.`,
    };
  }

  const rates = eligible.map((keyword) => stats.get(keyword)?.replyRate ?? 0);
  const mean = rates.reduce((sum, rate) => sum + rate, 0) / rates.length;
  if (mean <= 0) {
    return { action: 'unchanged', detail: 'Pesos de ICP: nenhuma resposta registrada ainda; pesos mantidos em 1.' };
  }

  const weights: Record<string, number> = {};
  for (const keyword of eligible) {
    const rate = stats.get(keyword)?.replyRate ?? 0;
    const damped = 1 + (rate / mean - 1) * LEARNING_DAMPENING;
    weights[keyword] = Number(Math.max(MIN_KEYWORD_WEIGHT, Math.min(MAX_KEYWORD_WEIGHT, damped)).toFixed(3));
  }

  writeStrategy('icp_keyword_weights', weights, 'optimizer', db);
  log.info('icp keyword weights learned', { weights });
  return {
    action: 'written',
    detail: `Pesos de ICP aprendidos para ${eligible.length} termos a partir da taxa de resposta.`,
  };
}

/** Learned multipliers for scoring. Absent or unlearned keywords stay at 1. */
export function learnedKeywordWeights(db: Db = getDb()): Record<string, number> {
  return readStrategy<Record<string, number>>('icp_keyword_weights', db) ?? {};
}
