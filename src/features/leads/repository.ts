import { and, desc, eq, inArray, isNotNull, lte, sql } from 'drizzle-orm';
import { getDb, transact, type Db } from '@/db/client';
import { leads, leadTags, type LeadRow } from '@/db/schema';
import { AppError } from '@/lib/errors';
import { newId } from '@/lib/ids';
import { nowIso } from '@/lib/time';
import { recordAudit, recordEvent } from '@/lib/audit';
import { getEnv } from '@/lib/env';
import { getBusinessConfig } from '@/config/business';
import { addDays } from '@/lib/time';
import { normalizeHandle } from './handle';
import { isSuppressed, suppress, type SuppressionReason } from './suppression';
import {
  assertChannelTransition,
  assertStageTransition,
  ownerForChannelState,
  type ChannelOwner,
  type ChannelState,
  type Funnel,
  type PipelineStage,
} from './states';
import { priorityForScore, qualifies, scoreLead, type PublicProfileSignals } from './scoring';

export interface DiscoveredProfile extends PublicProfileSignals {
  funnel: Funnel;
  discoverySource: string;
  sourceKeyword?: string | null;
  campaignId?: string | null;
  platformUserId?: string | null;
  /** Where each public field was observed; kept for provenance/auditability. */
  provenance?: Record<string, string>;
}

export type DiscoveryOutcome =
  | { status: 'created'; lead: LeadRow }
  | { status: 'duplicate'; lead: LeadRow }
  | { status: 'suppressed'; handle: string }
  | { status: 'own_account'; handle: string };

export function findLeadByHandle(handle: string, db: Db = getDb()): LeadRow | undefined {
  return db
    .select()
    .from(leads)
    .where(and(eq(leads.platform, 'instagram'), eq(leads.handle, normalizeHandle(handle))))
    .get();
}

export function getLead(id: string, db: Db = getDb()): LeadRow {
  const row = db.select().from(leads).where(eq(leads.id, id)).get();
  if (!row) throw new AppError('not_found', `Lead ${id} não encontrado.`);
  return row;
}

export function findLeadByPlatformUserId(platformUserId: string, db: Db = getDb()): LeadRow | undefined {
  return db
    .select()
    .from(leads)
    .where(and(eq(leads.platform, 'instagram'), eq(leads.platformUserId, platformUserId)))
    .get();
}

/**
 * Idempotent discovery. Deduplicates on (platform, handle), refuses anything on
 * the suppression list, and stores only the public signals actually observed.
 */
export function registerDiscoveredLead(profile: DiscoveredProfile): DiscoveryOutcome {
  const handle = normalizeHandle(profile.handle);
  // Our own account is never a prospect. The handle comes from the official
  // business record, so changing it there changes this check too.
  if (handle === normalizeHandle(getBusinessConfig().company.instagramHandle)) {
    return { status: 'own_account', handle };
  }
  return transact((db) => {
    if (isSuppressed(handle, 'instagram', db)) {
      recordEvent({ type: 'lead.discovery_suppressed', funnel: profile.funnel, payload: { source: profile.discoverySource } }, db);
      return { status: 'suppressed', handle } satisfies DiscoveryOutcome;
    }

    const existing = db
      .select()
      .from(leads)
      .where(and(eq(leads.platform, 'instagram'), eq(leads.handle, handle)))
      .get();

    if (existing) {
      recordEvent(
        { type: 'lead.discovery_duplicate', funnel: profile.funnel, leadId: existing.id, payload: { source: profile.discoverySource } },
        db,
      );
      return { status: 'duplicate', lead: existing } satisfies DiscoveryOutcome;
    }

    const scored = scoreLead(profile, profile.funnel);
    const now = nowIso();
    const retentionDays = getEnv().DATA_RETENTION_DAYS;
    const id = newId('lead');

    const row: LeadRow = {
      id,
      funnel: profile.funnel,
      platform: 'instagram',
      handle,
      platformUserId: profile.platformUserId ?? null,
      displayName: profile.displayName ?? null,
      bio: profile.bio ?? null,
      category: profile.category ?? null,
      location: profile.location ?? null,
      externalUrl: profile.externalUrl ?? null,
      followersCount: profile.followersCount ?? null,
      profileSnapshot: JSON.stringify({
        postHashtags: profile.postHashtags ?? [],
        postCaptions: profile.postCaptions ?? [],
        isBusinessAccount: profile.isBusinessAccount ?? null,
        provenance: profile.provenance ?? {},
        observedAt: now,
      }),
      discoverySource: profile.discoverySource,
      sourceKeyword: profile.sourceKeyword ?? null,
      campaignId: profile.campaignId ?? null,
      niche: scored.niche,
      persona: scored.persona,
      icpScore: scored.score,
      scoreBreakdown: JSON.stringify({ signals: scored.signals, matchedKeywords: scored.matchedKeywords }),
      priority: priorityForScore(scored.score),
      pipelineStage: 'discovered',
      channelState: 'browser_contact_pending',
      channelOwner: 'none',
      contactWindowStart: null,
      contactWindowEnd: null,
      nextActionAt: null,
      nextActionKind: null,
      contactedAt: null,
      repliedAt: null,
      lastInboundAt: null,
      lastOutboundAt: null,
      doNotContact: 0,
      blockedReason: null,
      retentionExpiresAt: addDays(new Date(now), retentionDays).toISOString(),
      createdAt: now,
      updatedAt: now,
    };

    db.insert(leads).values(row).run();
    recordEvent(
      {
        type: 'lead.discovered',
        funnel: profile.funnel,
        leadId: id,
        payload: { source: profile.discoverySource, keyword: profile.sourceKeyword ?? null, score: scored.score },
      },
      db,
    );
    recordAudit({ actor: 'worker', action: 'lead.create', entityType: 'lead', entityId: id, after: { handle, score: scored.score } }, db);
    return { status: 'created', lead: row } satisfies DiscoveryOutcome;
  });
}

export interface StageChange {
  leadId: string;
  to: PipelineStage;
  actor: 'operator' | 'worker' | 'ai' | 'system' | 'webhook';
  reason?: string;
}

export function transitionStage(change: StageChange, db: Db = getDb()): LeadRow {
  const lead = getLead(change.leadId, db);
  const funnel = lead.funnel as Funnel;
  assertStageTransition(funnel, lead.pipelineStage as PipelineStage, change.to);
  const now = nowIso();
  db.update(leads).set({ pipelineStage: change.to, updatedAt: now }).where(eq(leads.id, lead.id)).run();
  recordAudit(
    {
      actor: change.actor,
      action: 'lead.stage',
      entityType: 'lead',
      entityId: lead.id,
      before: { pipelineStage: lead.pipelineStage },
      after: { pipelineStage: change.to },
      reason: change.reason ?? null,
    },
    db,
  );
  recordEvent(
    { type: 'lead.stage_changed', funnel, leadId: lead.id, payload: { from: lead.pipelineStage, to: change.to } },
    db,
  );
  return { ...lead, pipelineStage: change.to, updatedAt: now };
}

/**
 * Closes a lead, tolerating a lead that is already closed. Terminal outcomes can
 * be reached from more than one path (no reply, profile gone, opt-out), so this
 * has to be idempotent.
 */
export function closeLead(
  leadId: string,
  reason: string,
  actor: 'operator' | 'worker' | 'ai' | 'system' | 'webhook',
  db: Db = getDb(),
): LeadRow {
  const lead = getLead(leadId, db);
  if (lead.pipelineStage === 'closed') return lead;
  return transitionStage({ leadId, to: 'closed', actor, reason }, db);
}

export interface ChannelChange {
  leadId: string;
  to: ChannelState;
  actor: 'operator' | 'worker' | 'ai' | 'system' | 'webhook';
  reason?: string;
  /** Explicit owner override; defaults to the owner implied by the state. */
  owner?: ChannelOwner;
}

export function transitionChannel(change: ChannelChange, db: Db = getDb()): LeadRow {
  const lead = getLead(change.leadId, db);
  assertChannelTransition(lead.channelState as ChannelState, change.to);
  const owner = change.owner ?? ownerForChannelState(change.to);
  const now = nowIso();
  db.update(leads)
    .set({ channelState: change.to, channelOwner: owner, updatedAt: now })
    .where(eq(leads.id, lead.id))
    .run();
  recordAudit(
    {
      actor: change.actor,
      action: 'lead.channel',
      entityType: 'lead',
      entityId: lead.id,
      before: { channelState: lead.channelState, channelOwner: lead.channelOwner },
      after: { channelState: change.to, channelOwner: owner },
      reason: change.reason ?? null,
    },
    db,
  );
  recordEvent(
    {
      type: 'lead.channel_changed',
      funnel: lead.funnel,
      leadId: lead.id,
      payload: { from: lead.channelState, to: change.to, owner },
    },
    db,
  );
  return { ...lead, channelState: change.to, channelOwner: owner, updatedAt: now };
}

export interface OptOutInput {
  leadId: string;
  reason: SuppressionReason;
  source: string;
  actor: 'operator' | 'worker' | 'ai' | 'webhook';
}

/**
 * Opt-out is immediate and terminal: the channel is closed, all pending jobs
 * for the lead are cancelled by the worker, and the handle enters the
 * suppression list so discovery can never re-surface it.
 */
export function applyDoNotContact(input: OptOutInput, db: Db = getDb()): LeadRow {
  const lead = getLead(input.leadId, db);
  const now = nowIso();
  db.update(leads)
    .set({
      doNotContact: 1,
      channelState: 'do_not_contact',
      channelOwner: 'none',
      nextActionAt: null,
      nextActionKind: null,
      blockedReason: input.reason,
      updatedAt: now,
    })
    .where(eq(leads.id, lead.id))
    .run();
  suppress({ handle: lead.handle, reason: input.reason, source: input.source }, db);
  recordAudit(
    {
      actor: input.actor,
      action: 'lead.do_not_contact',
      entityType: 'lead',
      entityId: lead.id,
      before: { channelState: lead.channelState, doNotContact: lead.doNotContact },
      after: { channelState: 'do_not_contact', doNotContact: 1 },
      reason: input.reason,
    },
    db,
  );
  recordEvent({ type: 'lead.opt_out', funnel: lead.funnel, leadId: lead.id, payload: { reason: input.reason } }, db);
  return { ...lead, doNotContact: 1, channelState: 'do_not_contact', channelOwner: 'none', updatedAt: now };
}

export interface QualifyResult {
  lead: LeadRow;
  qualified: boolean;
  score: number;
}

/** Re-scores a lead against the current ICP and moves it to `qualified`. */
export function qualifyLead(leadId: string, db: Db = getDb()): QualifyResult {
  const lead = getLead(leadId, db);
  const snapshot = JSON.parse(lead.profileSnapshot) as {
    postHashtags?: string[];
    postCaptions?: string[];
    isBusinessAccount?: boolean | null;
  };
  const scored = scoreLead(
    {
      handle: lead.handle,
      displayName: lead.displayName,
      bio: lead.bio,
      category: lead.category,
      location: lead.location,
      externalUrl: lead.externalUrl,
      followersCount: lead.followersCount,
      postHashtags: snapshot.postHashtags ?? [],
      postCaptions: snapshot.postCaptions ?? [],
      isBusinessAccount: snapshot.isBusinessAccount ?? null,
    },
    lead.funnel as Funnel,
  );

  const now = nowIso();
  db.update(leads)
    .set({
      icpScore: scored.score,
      scoreBreakdown: JSON.stringify({ signals: scored.signals, matchedKeywords: scored.matchedKeywords }),
      persona: scored.persona,
      niche: scored.niche,
      priority: priorityForScore(scored.score),
      updatedAt: now,
    })
    .where(eq(leads.id, lead.id))
    .run();

  const passed = qualifies(scored.score);
  const updated = passed
    ? transitionStage({ leadId: lead.id, to: 'qualified', actor: 'worker', reason: `score=${scored.score}` }, db)
    : closeLead(lead.id, `fora do ICP (score=${scored.score})`, 'worker', db);

  recordEvent(
    { type: 'lead.qualified', funnel: lead.funnel, leadId: lead.id, payload: { score: scored.score, qualified: passed } },
    db,
  );

  return { lead: { ...updated, icpScore: scored.score, priority: priorityForScore(scored.score) }, qualified: passed, score: scored.score };
}

export interface LeadFilter {
  funnel?: Funnel;
  stages?: PipelineStage[];
  channelStates?: ChannelState[];
  search?: string;
  limit?: number;
}

export function listLeads(filter: LeadFilter = {}, db: Db = getDb()): LeadRow[] {
  const conditions = [];
  if (filter.funnel) conditions.push(eq(leads.funnel, filter.funnel));
  if (filter.stages && filter.stages.length > 0) conditions.push(inArray(leads.pipelineStage, filter.stages));
  if (filter.channelStates && filter.channelStates.length > 0) {
    conditions.push(inArray(leads.channelState, filter.channelStates));
  }
  if (filter.search && filter.search.trim().length > 0) {
    const needle = `%${filter.search.trim().toLowerCase()}%`;
    conditions.push(sql`(lower(${leads.handle}) LIKE ${needle} OR lower(coalesce(${leads.displayName}, '')) LIKE ${needle})`);
  }
  const query = db.select().from(leads);
  const filtered = conditions.length > 0 ? query.where(and(...conditions)) : query;
  return filtered.orderBy(desc(leads.priority), desc(leads.icpScore), desc(leads.updatedAt)).limit(filter.limit ?? 500).all();
}

export function leadsDueForAction(now: Date, db: Db = getDb()): LeadRow[] {
  return db
    .select()
    .from(leads)
    .where(and(isNotNull(leads.nextActionAt), lte(leads.nextActionAt, now.toISOString()), eq(leads.doNotContact, 0)))
    .orderBy(desc(leads.priority))
    .all();
}

export function setNextAction(leadId: string, at: string | null, kind: string | null, db: Db = getDb()): void {
  db.update(leads).set({ nextActionAt: at, nextActionKind: kind, updatedAt: nowIso() }).where(eq(leads.id, leadId)).run();
}

export function addLeadTag(leadId: string, tag: string, db: Db = getDb()): void {
  db.insert(leadTags).values({ leadId, tag, createdAt: nowIso() }).onConflictDoNothing().run();
}

export function leadTagList(leadId: string, db: Db = getDb()): string[] {
  return db
    .select({ tag: leadTags.tag })
    .from(leadTags)
    .where(eq(leadTags.leadId, leadId))
    .all()
    .map((row) => row.tag);
}
