import { describe, expect, it } from 'vitest';
import { withTestDatabase } from '../helpers/db';
import { getBusinessConfig } from '@/config/business';
import { registerDiscoveredLead, transitionStage } from '@/features/leads/repository';
import { discoveryKeywords } from '@/features/leads/discovery';
import { scoreLead } from '@/features/leads/scoring';
import { readStrategy } from '@/features/experiments/strategy-store';
import {
  MAX_KEYWORD_WEIGHT,
  MIN_CONTACTED_FOR_WEIGHTS,
  MIN_KEYWORD_WEIGHT,
  MIN_LEADS_FOR_RANKING,
  keywordPerformance,
  learnDiscoveryRanking,
  learnIcpKeywordWeights,
  learnedKeywordWeights,
} from '@/features/experiments/keyword-learning';

withTestDatabase();

const OFFICIAL = getBusinessConfig().icp.keywords;
if (OFFICIAL.length < 2) throw new Error('config/business.json precisa de ao menos duas palavras-chave de ICP');
const KEYWORD_A = OFFICIAL[0] as string;
const KEYWORD_B = OFFICIAL[1] as string;

let counter = 0;

/**
 * Creates leads for a keyword and walks the given share of them up the funnel.
 * The learners read the immutable event log, so the stages have to be reached
 * through real transitions rather than written directly.
 */
function seedKeyword(keyword: string, options: { total: number; qualified?: number; contacted?: number; replied?: number }): void {
  for (let index = 0; index < options.total; index += 1) {
    counter += 1;
    const outcome = registerDiscoveredLead({
      handle: `lead_${counter}_${keyword.replace(/\W+/g, '_')}`,
      displayName: 'Empresa Teste',
      bio: 'Perfil de teste para aprendizado de palavras-chave.',
      funnel: 'customer',
      discoverySource: 'test',
      sourceKeyword: keyword,
    });
    if (outcome.status !== 'created') throw new Error(`esperava lead novo, veio ${outcome.status}`);

    const id = outcome.lead.id;
    if (index < (options.qualified ?? 0)) {
      transitionStage({ leadId: id, to: 'qualified', actor: 'worker', reason: 'teste' });
    }
    if (index < (options.contacted ?? 0)) {
      transitionStage({ leadId: id, to: 'contacted', actor: 'worker', reason: 'teste' });
    }
    if (index < (options.replied ?? 0)) {
      transitionStage({ leadId: id, to: 'replied', actor: 'worker', reason: 'teste' });
    }
  }
}

describe('keyword performance', () => {
  it('counts stages from the event log, not the current stage', () => {
    // A lead that replied is no longer *at* `contacted`, but it was contacted.
    seedKeyword(KEYWORD_A, { total: 3, qualified: 3, contacted: 3, replied: 2 });

    const stats = keywordPerformance().find((entry) => entry.keyword === KEYWORD_A);

    expect(stats).toMatchObject({ discovered: 3, qualified: 3, contacted: 3, replied: 2 });
    expect(stats?.replyRate).toBeCloseTo(2 / 3);
  });
});

/**
 * Both loops must refuse to act on thin data. Acting on a handful of leads is
 * not learning, it is amplified noise - and a keyword weight decides who gets
 * messaged.
 */
describe('evidence gates', () => {
  it('does not rank discovery terms before there is enough evidence', () => {
    seedKeyword(KEYWORD_A, { total: MIN_LEADS_FOR_RANKING - 1, qualified: 5 });
    seedKeyword(KEYWORD_B, { total: MIN_LEADS_FOR_RANKING - 1, qualified: 1 });

    const outcome = learnDiscoveryRanking();

    expect(outcome.action).toBe('unchanged');
    expect(readStrategy('discovery_hints')).toBeUndefined();
  });

  it('does not weight ICP keywords before enough leads were contacted', () => {
    seedKeyword(KEYWORD_A, { total: 20, qualified: 20, contacted: MIN_CONTACTED_FOR_WEIGHTS - 1, replied: 8 });
    seedKeyword(KEYWORD_B, { total: 20, qualified: 20, contacted: MIN_CONTACTED_FOR_WEIGHTS - 1, replied: 1 });

    const outcome = learnIcpKeywordWeights();

    expect(outcome.action).toBe('unchanged');
    expect(learnedKeywordWeights()).toEqual({});
  });

  it('writes nothing while no one has replied', () => {
    seedKeyword(KEYWORD_A, { total: 20, qualified: 20, contacted: 20, replied: 0 });
    seedKeyword(KEYWORD_B, { total: 20, qualified: 20, contacted: 20, replied: 0 });

    expect(learnIcpKeywordWeights().action).toBe('unchanged');
    expect(learnedKeywordWeights()).toEqual({});
  });
});

describe('discovery ranking', () => {
  it('ranks proven terms by qualification rate', () => {
    seedKeyword(KEYWORD_A, { total: 10, qualified: 2 });
    seedKeyword(KEYWORD_B, { total: 10, qualified: 8 });

    const outcome = learnDiscoveryRanking();

    expect(outcome.action).toBe('written');
    expect(readStrategy<{ ranking: string[] }>('discovery_hints')?.ranking).toEqual([KEYWORD_B, KEYWORD_A]);
  });

  it('never drops an official ICP keyword from the search', () => {
    // The learned ranking only covers proven terms. The official list is the
    // operator's definition of the market: a term may lose priority, but it
    // must never disappear because the system has not measured it yet.
    seedKeyword(KEYWORD_A, { total: 10, qualified: 2 });
    seedKeyword(KEYWORD_B, { total: 10, qualified: 8 });
    learnDiscoveryRanking();

    const searched = discoveryKeywords('customer');

    for (const keyword of OFFICIAL) expect(searched).toContain(keyword);
    expect(searched[0]).toBe(KEYWORD_B);
  });
});

describe('learned ICP weights', () => {
  it('favours the keyword whose leads actually answer, at half strength', () => {
    seedKeyword(KEYWORD_A, { total: 20, qualified: 20, contacted: 20, replied: 2 });
    seedKeyword(KEYWORD_B, { total: 20, qualified: 20, contacted: 20, replied: 10 });

    expect(learnIcpKeywordWeights().action).toBe('written');
    const weights = learnedKeywordWeights();

    expect(weights[KEYWORD_B]).toBeGreaterThan(1);
    expect(weights[KEYWORD_A]).toBeLessThan(1);
    for (const value of Object.values(weights)) {
      expect(value).toBeGreaterThanOrEqual(MIN_KEYWORD_WEIGHT);
      expect(value).toBeLessThanOrEqual(MAX_KEYWORD_WEIGHT);
    }
  });

  it('stays inside the clamp even when one keyword answers and the other never does', () => {
    seedKeyword(KEYWORD_A, { total: 20, qualified: 20, contacted: 20, replied: 0 });
    seedKeyword(KEYWORD_B, { total: 20, qualified: 20, contacted: 20, replied: 20 });

    learnIcpKeywordWeights();
    const weights = learnedKeywordWeights();

    expect(weights[KEYWORD_B]).toBeLessThanOrEqual(MAX_KEYWORD_WEIGHT);
    expect(weights[KEYWORD_A]).toBeGreaterThanOrEqual(MIN_KEYWORD_WEIGHT);
  });

  it('changes the score a profile receives', () => {
    const profile = { handle: 'perfil_teste', bio: `Somos uma ${KEYWORD_B} na região.` };

    const neutral = scoreLead(profile, 'customer');
    const boosted = scoreLead(profile, 'customer', { learnedWeights: { [KEYWORD_B]: MAX_KEYWORD_WEIGHT } });
    const damped = scoreLead(profile, 'customer', { learnedWeights: { [KEYWORD_B]: MIN_KEYWORD_WEIGHT } });

    expect(boosted.score).toBeGreaterThan(neutral.score);
    expect(damped.score).toBeLessThan(neutral.score);
  });
});
