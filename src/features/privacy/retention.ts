import { and, eq, isNotNull, lte, ne } from 'drizzle-orm';
import { getDb, transact, type Db } from '@/db/client';
import { leads, messages } from '@/db/schema';
import { nowIso } from '@/lib/time';
import { recordAudit, recordEvent } from '@/lib/audit';
import { createLogger } from '@/lib/logger';
import { suppressionHash } from '@/features/leads/suppression';

const log = createLogger('retention');

/**
 * Retention policy.
 *
 * Leads that never became customers are anonymised once their retention window
 * expires: the public profile data we collected is dropped and only a hashed
 * handle plus the aggregate outcome remain, which is the minimum needed to keep
 * measuring the funnel and to keep honouring opt-outs.
 */

export interface RetentionResult {
  anonymized: number;
  messagesCleared: number;
}

const PROTECTED_STAGES = ['active_customer', 'active_affiliate', 'generated_customer', 'registered'];

export function anonymizeExpiredLeads(now: Date = new Date(), db: Db = getDb()): RetentionResult {
  const expired = db
    .select()
    .from(leads)
    .where(
      and(
        isNotNull(leads.retentionExpiresAt),
        lte(leads.retentionExpiresAt, now.toISOString()),
        ne(leads.discoverySource, 'anonymized'),
      ),
    )
    .all()
    .filter((lead) => !PROTECTED_STAGES.includes(lead.pipelineStage));

  let messagesCleared = 0;

  for (const lead of expired) {
    transact((tx) => {
      const cleared = tx
        .update(messages)
        .set({ body: '[conteúdo removido pela política de retenção]', meta: '{}' })
        .where(eq(messages.leadId, lead.id))
        .run();
      messagesCleared += cleared.changes;

      tx.update(leads)
        .set({
          handle: `anon_${suppressionHash(lead.handle, lead.platform).slice(0, 24)}`,
          displayName: null,
          bio: null,
          category: null,
          location: null,
          externalUrl: null,
          followersCount: null,
          profileSnapshot: '{}',
          platformUserId: null,
          discoverySource: 'anonymized',
          updatedAt: nowIso(),
        })
        .where(eq(leads.id, lead.id))
        .run();

      recordAudit(
        {
          actor: 'system',
          action: 'lead.anonymize',
          entityType: 'lead',
          entityId: lead.id,
          reason: 'retenção expirada',
        },
        tx,
      );
    });
  }

  if (expired.length > 0) {
    recordEvent({ type: 'privacy.retention_applied', payload: { anonymized: expired.length, messagesCleared } }, db);
    log.info('retention applied', { anonymized: expired.length });
  }

  return { anonymized: expired.length, messagesCleared };
}
