import { eq } from 'drizzle-orm';
import { getDb, type Db } from '@/db/client';
import { capabilityPauses } from '@/db/schema';
import { businessCapabilities } from '@/config/business';
import { envCapabilities, getEnv } from '@/lib/env';
import { recordAudit, raiseAlert } from '@/lib/audit';
import { nowIso } from '@/lib/time';
import { AppError } from '@/lib/errors';

/**
 * Runtime capabilities. A capability is usable only when it is configured
 * (env + business config) *and* not paused.
 */

export const RUNTIME_CAPABILITIES = [
  'global',
  'discovery',
  'browser_outreach',
  'api_messaging',
  'ai_engine',
  'customer_funnel',
  'affiliate_funnel',
] as const;

export type RuntimeCapability = (typeof RUNTIME_CAPABILITIES)[number];

export interface CapabilityReport {
  id: RuntimeCapability;
  /** Label shown to the operator (PT-BR lives in the UI layer). */
  configured: boolean;
  paused: boolean;
  usable: boolean;
  missing: string[];
  pauseReason: string | null;
  pausedAt: string | null;
}

interface PauseRow {
  capability: string;
  paused: number;
  reason: string | null;
  pausedAt: string | null;
}

function pauseRows(db: Db): Map<string, PauseRow> {
  const rows = db
    .select({
      capability: capabilityPauses.capability,
      paused: capabilityPauses.paused,
      reason: capabilityPauses.reason,
      pausedAt: capabilityPauses.pausedAt,
    })
    .from(capabilityPauses)
    .all();
  return new Map(rows.map((row) => [row.capability, row]));
}

function configuredState(): Record<RuntimeCapability, { configured: boolean; missing: string[] }> {
  const env = getEnv();
  const envState = envCapabilities(env);
  const business = businessCapabilities();
  const find = (id: string): string[] => business.find((entry) => entry.id === id)?.missing ?? [];

  const customerMissing = find('customer_funnel');
  const affiliateMissing = find('affiliate_funnel');

  return {
    global: { configured: true, missing: [] },
    discovery: { configured: true, missing: [] },
    browser_outreach: {
      configured: envState.browser,
      missing: envState.browser ? [] : ['CHROME_CDP_URL'],
    },
    api_messaging: {
      configured: envState.instagramApi,
      missing: envState.instagramApi ? [] : ['INSTAGRAM_PAGE_ACCESS_TOKEN', 'INSTAGRAM_BUSINESS_ACCOUNT_ID'],
    },
    ai_engine: {
      configured: envState.openai,
      missing: envState.openai ? [] : ['OPENAI_API_KEY'],
    },
    customer_funnel: { configured: customerMissing.length === 0, missing: customerMissing },
    affiliate_funnel: { configured: affiliateMissing.length === 0, missing: affiliateMissing },
  };
}

export function capabilityReport(db: Db = getDb()): CapabilityReport[] {
  const pauses = pauseRows(db);
  const configured = configuredState();
  const globalPaused = pauses.get('global')?.paused === 1;

  return RUNTIME_CAPABILITIES.map((id) => {
    const state = configured[id];
    const row = pauses.get(id);
    const paused = row?.paused === 1 || (id !== 'global' && globalPaused);
    const pauseRow = row?.paused === 1 ? row : globalPaused ? pauses.get('global') : undefined;
    return {
      id,
      configured: state.configured,
      paused,
      usable: state.configured && !paused,
      missing: state.missing,
      pauseReason: pauseRow?.reason ?? null,
      pausedAt: pauseRow?.pausedAt ?? null,
    };
  });
}

export function isCapabilityUsable(id: RuntimeCapability, db: Db = getDb()): boolean {
  return capabilityReport(db).some((entry) => entry.id === id && entry.usable);
}

export function requireUsableCapability(id: RuntimeCapability, db: Db = getDb()): void {
  const entry = capabilityReport(db).find((report) => report.id === id);
  if (!entry) throw new AppError('capability_disabled', `Capacidade desconhecida: ${id}`);
  if (!entry.configured) {
    throw new AppError('capability_disabled', `Capacidade "${id}" não configurada.`, {
      details: { capability: id, missing: entry.missing },
    });
  }
  if (entry.paused) {
    throw new AppError('system_paused', `Capacidade "${id}" pausada: ${entry.pauseReason ?? 'sem motivo registrado'}`, {
      details: { capability: id },
    });
  }
}

export interface PauseInput {
  capability: RuntimeCapability;
  reason: string;
  by: 'operator' | 'system' | 'worker';
  details?: Record<string, unknown>;
  /** Safety pauses also open an operator alert. */
  alert?: { severity: 'warning' | 'critical'; code: string; title: string };
}

export function pauseCapability(input: PauseInput, db: Db = getDb()): void {
  const now = nowIso();
  db.insert(capabilityPauses)
    .values({
      capability: input.capability,
      paused: 1,
      reason: input.reason,
      details: JSON.stringify(input.details ?? {}),
      pausedBy: input.by,
      pausedAt: now,
      resumedAt: null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: capabilityPauses.capability,
      set: {
        paused: 1,
        reason: input.reason,
        details: JSON.stringify(input.details ?? {}),
        pausedBy: input.by,
        pausedAt: now,
        resumedAt: null,
        updatedAt: now,
      },
    })
    .run();

  recordAudit(
    {
      actor: input.by,
      action: 'capability.pause',
      entityType: 'capability',
      entityId: input.capability,
      after: { paused: true, reason: input.reason },
      reason: input.reason,
    },
    db,
  );

  if (input.alert) {
    raiseAlert(
      {
        kind: 'safety',
        severity: input.alert.severity,
        code: input.alert.code,
        title: input.alert.title,
        detail: input.reason,
        context: { capability: input.capability, ...(input.details ?? {}) },
        dedupeKey: `pause:${input.capability}:${input.alert.code}`,
      },
      db,
    );
  }
}

export function resumeCapability(capability: RuntimeCapability, by: 'operator' | 'system', db: Db = getDb()): void {
  const now = nowIso();
  db.update(capabilityPauses)
    .set({ paused: 0, resumedAt: now, updatedAt: now })
    .where(eq(capabilityPauses.capability, capability))
    .run();
  recordAudit(
    {
      actor: by,
      action: 'capability.resume',
      entityType: 'capability',
      entityId: capability,
      after: { paused: false },
    },
    db,
  );
}
