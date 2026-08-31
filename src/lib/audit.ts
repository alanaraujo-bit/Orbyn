import { eq } from 'drizzle-orm';
import { getDb, type Db } from '@/db/client';
import { alerts, auditLog, events } from '@/db/schema';
import { newId } from './ids';
import { nowIso } from './time';
import { redact } from './redact';

export type Actor = 'operator' | 'worker' | 'ai' | 'system' | 'webhook';

export interface AuditInput {
  actor: Actor;
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
}

export function recordAudit(input: AuditInput, db: Db = getDb()): string {
  const id = newId('aud');
  db.insert(auditLog)
    .values({
      id,
      actor: input.actor,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      beforeState: input.before === undefined ? null : JSON.stringify(redact(input.before)),
      afterState: input.after === undefined ? null : JSON.stringify(redact(input.after)),
      reason: input.reason ?? null,
      createdAt: nowIso(),
    })
    .run();
  return id;
}

export interface EventInput {
  type: string;
  funnel?: string | null;
  leadId?: string | null;
  conversationId?: string | null;
  experimentId?: string | null;
  variantId?: string | null;
  payload?: Record<string, unknown>;
  occurredAt?: string;
}

export function recordEvent(input: EventInput, db: Db = getDb()): string {
  const id = newId('evt');
  db.insert(events)
    .values({
      id,
      type: input.type,
      funnel: input.funnel ?? null,
      leadId: input.leadId ?? null,
      conversationId: input.conversationId ?? null,
      experimentId: input.experimentId ?? null,
      variantId: input.variantId ?? null,
      payload: JSON.stringify(redact(input.payload ?? {})),
      occurredAt: input.occurredAt ?? nowIso(),
    })
    .run();
  return id;
}

export type AlertKind = 'exception' | 'integration' | 'safety' | 'budget' | 'data_integrity';
export type AlertSeverity = 'info' | 'warning' | 'critical';

export interface AlertInput {
  kind: AlertKind;
  severity: AlertSeverity;
  code: string;
  title: string;
  detail?: string;
  context?: Record<string, unknown>;
  leadId?: string | null;
  jobId?: string | null;
  /** When set, an identical open alert is reused instead of duplicated. */
  dedupeKey?: string | null;
}

export function raiseAlert(input: AlertInput, db: Db = getDb()): string {
  const now = nowIso();
  if (input.dedupeKey) {
    const existing = db
      .select({ id: alerts.id, status: alerts.status })
      .from(alerts)
      .where(eq(alerts.dedupeKey, input.dedupeKey))
      .all()
      .find((row) => row.status === 'open');
    if (existing) {
      db.update(alerts)
        .set({ detail: input.detail ?? '', context: JSON.stringify(redact(input.context ?? {})), updatedAt: now })
        .where(eq(alerts.id, existing.id))
        .run();
      return existing.id;
    }
  }
  const id = newId('alr');
  db.insert(alerts)
    .values({
      id,
      kind: input.kind,
      severity: input.severity,
      code: input.code,
      title: input.title,
      detail: input.detail ?? '',
      context: JSON.stringify(redact(input.context ?? {})),
      leadId: input.leadId ?? null,
      jobId: input.jobId ?? null,
      status: 'open',
      dedupeKey: input.dedupeKey ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return id;
}
