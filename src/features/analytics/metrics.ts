import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { getDb, type Db } from '@/db/client';
import { aiCalls, alerts, events, leads, messages } from '@/db/schema';
import { budgetStatus, monthStartIso } from '@/integrations/openai/usage';
import { effectiveDailyCap, dmsSentToday } from '@/features/campaigns/guardrails';
import { stagesForFunnel, type Funnel, type PipelineStage } from '@/features/leads/states';

/**
 * Panel metrics.
 *
 * Every ratio here has a real denominator. When the denominator does not exist
 * yet the value is `null` and the panel says so, instead of showing a zero that
 * looks like a measurement.
 */

export interface StageCount {
  stage: PipelineStage;
  count: number;
}

export function funnelCounts(funnel: Funnel, db: Db = getDb()): StageCount[] {
  const rows = db
    .select({ stage: leads.pipelineStage, count: sql<number>`count(*)` })
    .from(leads)
    .where(eq(leads.funnel, funnel))
    .groupBy(leads.pipelineStage)
    .all();
  const map = new Map(rows.map((row) => [row.stage, Number(row.count)]));
  return stagesForFunnel(funnel).map((stage) => ({ stage, count: map.get(stage) ?? 0 }));
}

/** Leads that ever reached a stage, from the event log rather than current state. */
export function reachedCount(stage: PipelineStage, funnel: Funnel | null, db: Db = getDb()): number {
  const rows = db
    .select({ leadId: events.leadId, payload: events.payload, funnel: events.funnel })
    .from(events)
    .where(eq(events.type, 'lead.stage_changed'))
    .all();
  const reached = new Set<string>();
  for (const row of rows) {
    if (!row.leadId) continue;
    if (funnel && row.funnel !== funnel) continue;
    try {
      if ((JSON.parse(row.payload) as { to?: string }).to === stage) reached.add(row.leadId);
    } catch {
      continue;
    }
  }
  return reached.size;
}

export interface PipelineTotals {
  discovered: number;
  contacted: number;
  replied: number;
  interested: number;
  handedOff: number;
  activeCustomers: number;
}

export function pipelineTotals(funnel: Funnel, db: Db = getDb()): PipelineTotals {
  const discovered = db.select({ id: leads.id }).from(leads).where(eq(leads.funnel, funnel)).all().length;
  return {
    discovered,
    contacted: reachedCount('contacted', funnel, db),
    replied: reachedCount('replied', funnel, db),
    interested: reachedCount('interested', funnel, db),
    handedOff: reachedCount(funnel === 'customer' ? 'whatsapp_handoff' : 'joined_affiliate_group', funnel, db),
    activeCustomers: reachedCount(funnel === 'customer' ? 'active_customer' : 'generated_customer', funnel, db),
  };
}

export function ratio(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return numerator / denominator;
}

export interface CostMetrics {
  spentUsd: number;
  budgetUsd: number;
  remainingUsd: number;
  exceeded: boolean;
  pricesConfigured: boolean;
  hasUnpricedCalls: boolean;
  callCount: number;
  /** Input tokens served from the prompt cache this month. */
  cachedInputTokens: number;
  perDiscoveredLead: number | null;
  perContactedLead: number | null;
  perReply: number | null;
  perOpportunity: number | null;
  perActiveCustomer: number | null;
}

export function costMetrics(db: Db = getDb()): CostMetrics {
  const budget = budgetStatus(new Date(), db);
  const since = monthStartIso();
  const monthCalls = db
    .select({ id: aiCalls.id, cached: aiCalls.cachedInputTokens })
    .from(aiCalls)
    .where(gte(aiCalls.createdAt, since))
    .all();
  const callCount = monthCalls.length;
  const cachedInputTokens = monthCalls.reduce((total, row) => total + row.cached, 0);
  const totals = pipelineTotals('customer', db);

  return {
    spentUsd: budget.spentUsd,
    budgetUsd: budget.budgetUsd,
    remainingUsd: budget.remainingUsd,
    exceeded: budget.exceeded,
    pricesConfigured: budget.pricesConfigured,
    hasUnpricedCalls: budget.hasUnpricedCalls,
    callCount,
    cachedInputTokens,
    perDiscoveredLead: ratio(budget.spentUsd, totals.discovered),
    perContactedLead: ratio(budget.spentUsd, totals.contacted),
    perReply: ratio(budget.spentUsd, totals.replied),
    perOpportunity: ratio(budget.spentUsd, totals.handedOff),
    perActiveCustomer: ratio(budget.spentUsd, totals.activeCustomers),
  };
}

export interface TodayStats {
  dmsSent: number;
  dailyCap: number;
  remaining: number;
  inboundToday: number;
}

export function todayStats(now: Date = new Date(), db: Db = getDb()): TodayStats {
  const sent = dmsSentToday(now, db);
  const cap = effectiveDailyCap(now, db);
  const since = new Date(now.getTime() - 24 * 3600_000).toISOString();
  const inbound = db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.direction, 'inbound'), gte(messages.createdAt, since)))
    .all().length;
  return { dmsSent: sent, dailyCap: cap, remaining: Math.max(0, cap - sent), inboundToday: inbound };
}

export interface KeywordPerformance {
  keyword: string;
  discovered: number;
  contacted: number;
  replied: number;
  replyRate: number | null;
}

/** Only keywords with enough volume to mean anything are returned. */
export function keywordPerformance(minVolume = 5, db: Db = getDb()): KeywordPerformance[] {
  const rows = db
    .select({
      keyword: leads.sourceKeyword,
      discovered: sql<number>`count(*)`,
      contacted: sql<number>`sum(case when ${leads.contactedAt} is not null then 1 else 0 end)`,
      replied: sql<number>`sum(case when ${leads.repliedAt} is not null then 1 else 0 end)`,
    })
    .from(leads)
    .groupBy(leads.sourceKeyword)
    .all();

  return rows
    .filter((row) => row.keyword !== null && Number(row.discovered) >= minVolume)
    .map((row) => ({
      keyword: row.keyword ?? '—',
      discovered: Number(row.discovered),
      contacted: Number(row.contacted),
      replied: Number(row.replied),
      replyRate: ratio(Number(row.replied), Number(row.contacted)),
    }))
    .sort((a, b) => b.discovered - a.discovered);
}

export function openAlertCount(db: Db = getDb()): number {
  return db.select({ id: alerts.id }).from(alerts).where(eq(alerts.status, 'open')).all().length;
}

export function recentEvents(limit = 20, db: Db = getDb()) {
  return db.select().from(events).orderBy(desc(events.occurredAt)).limit(limit).all();
}
