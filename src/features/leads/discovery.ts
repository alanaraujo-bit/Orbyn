import { getDb, type Db } from '@/db/client';
import { createLogger } from '@/lib/logger';
import { idempotencyKey } from '@/lib/ids';
import { recordEvent } from '@/lib/audit';
import { getBusinessConfig } from '@/config/business';
import { isCapabilityUsable } from '@/features/system/capabilities';
import { readStrategy } from '@/features/experiments/strategy-store';
import { enqueue } from '@/worker/queue';
import { readPublicProfile, searchPublicProfiles } from '@/integrations/browser/instagram-discovery';
import { normalizeHandle } from './handle';
import { registerDiscoveredLead, type DiscoveredProfile } from './repository';
import type { Funnel } from './states';

const log = createLogger('discovery');

/**
 * Discovery.
 *
 * Keyword sources always start from the official ICP in
 * `config/business.json`. Learned hints stored in `strategy_state` may re-order
 * or extend the *search* terms, but they never redefine the ICP itself.
 */

export interface ProfileDraft {
  handle: string;
  displayName?: string | null;
  bio?: string | null;
  category?: string | null;
  location?: string | null;
  externalUrl?: string | null;
  followersCount?: number | null;
  postHashtags?: string[];
  postCaptions?: string[];
  isBusinessAccount?: boolean | null;
  provenance?: Record<string, string>;
}

export interface DiscoverySource {
  readonly name: string;
  discover(keyword: string, limit: number): Promise<ProfileDraft[]>;
}

/** Operator-provided list: the source that always works, with no browser. */
export class ManualDiscoverySource implements DiscoverySource {
  readonly name = 'manual';
  constructor(private readonly drafts: ProfileDraft[]) {}

  async discover(_keyword: string, limit: number): Promise<ProfileDraft[]> {
    return this.drafts.slice(0, limit);
  }
}

/** Deterministic source used by tests and by the simulated pipeline run. */
export class SimulatedDiscoverySource implements DiscoverySource {
  readonly name = 'simulated';
  constructor(private readonly byKeyword: Record<string, ProfileDraft[]>) {}

  async discover(keyword: string, limit: number): Promise<ProfileDraft[]> {
    return (this.byKeyword[keyword] ?? []).slice(0, limit);
  }
}

/** Real source: Instagram's own public search, driven through the agent tab. */
export class InstagramBrowserDiscoverySource implements DiscoverySource {
  readonly name = 'instagram_browser_search';

  async discover(keyword: string, limit: number): Promise<ProfileDraft[]> {
    const handles = await searchPublicProfiles(keyword, limit);
    const drafts: ProfileDraft[] = [];
    for (const handle of handles) {
      const profile = await readPublicProfile(handle);
      if (!profile) continue;
      drafts.push(profile);
    }
    return drafts;
  }
}

export interface DiscoveryRunInput {
  funnel: Funnel;
  source: DiscoverySource;
  /** Defaults to the ICP keywords (or affiliate topics) from the config. */
  keywords?: string[];
  limitPerKeyword?: number;
  campaignId?: string | null;
}

export interface DiscoveryRunResult {
  created: number;
  duplicates: number;
  suppressed: number;
  skippedOwnAccount: number;
  invalid: number;
  perKeyword: { keyword: string; created: number; duplicates: number }[];
}

export function discoveryKeywords(funnel: Funnel, db: Db = getDb()): string[] {
  const config = getBusinessConfig();
  const official = funnel === 'customer' ? config.icp.keywords : config.affiliateProgram.topics;
  const hints = readStrategy<{ extraTerms?: string[]; ranking?: string[] }>('discovery_hints', db) ?? {};
  const ranked = [...official].sort((a, b) => {
    const rank = hints.ranking ?? [];
    const indexA = rank.indexOf(a);
    const indexB = rank.indexOf(b);
    if (indexA === indexB) return 0;
    if (indexA === -1) return 1;
    if (indexB === -1) return -1;
    return indexA - indexB;
  });
  // Learned terms are *additional* search inputs; they never replace the ICP.
  return [...ranked, ...(hints.extraTerms ?? []).filter((term) => !ranked.includes(term))];
}

export async function runDiscovery(input: DiscoveryRunInput, db: Db = getDb()): Promise<DiscoveryRunResult> {
  const keywords = input.keywords ?? discoveryKeywords(input.funnel, db);
  const limit = input.limitPerKeyword ?? 10;
  const result: DiscoveryRunResult = { created: 0, duplicates: 0, suppressed: 0, skippedOwnAccount: 0, invalid: 0, perKeyword: [] };

  for (const keyword of keywords) {
    const drafts = await input.source.discover(keyword, limit);
    let created = 0;
    let duplicates = 0;

    for (const draft of drafts) {
      let handle: string;
      try {
        handle = normalizeHandle(draft.handle);
      } catch {
        result.invalid += 1;
        continue;
      }

      const profile: DiscoveredProfile = {
        ...draft,
        handle,
        funnel: input.funnel,
        discoverySource: input.source.name,
        sourceKeyword: keyword,
        campaignId: input.campaignId ?? null,
      };

      const outcome = registerDiscoveredLead(profile);
      if (outcome.status === 'created') {
        created += 1;
        result.created += 1;
        enqueue(
          {
            type: 'qualify_lead',
            payload: { leadId: outcome.lead.id },
            leadId: outcome.lead.id,
            idempotencyKey: idempotencyKey('qualify_lead', outcome.lead.id),
            priority: 1,
          },
          db,
        );
      } else if (outcome.status === 'duplicate') {
        duplicates += 1;
        result.duplicates += 1;
      } else if (outcome.status === 'own_account') {
        result.skippedOwnAccount += 1;
      } else {
        result.suppressed += 1;
      }
    }

    result.perKeyword.push({ keyword, created, duplicates });
  }

  recordEvent({ type: 'discovery.run', funnel: input.funnel, payload: { source: input.source.name, ...result } }, db);
  log.info('discovery run finished', { source: input.source.name, created: result.created });
  return result;
}

/** Chooses the best available source for the current environment. */
export function defaultDiscoverySource(db: Db = getDb()): DiscoverySource | null {
  if (isCapabilityUsable('browser_outreach', db)) return new InstagramBrowserDiscoverySource();
  return null;
}
