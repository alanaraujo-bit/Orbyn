import { and, eq } from 'drizzle-orm';
import { getDb, type Db } from '@/db/client';
import { suppressionList } from '@/db/schema';
import { newId, sha256 } from '@/lib/ids';
import { nowIso } from '@/lib/time';
import { recordAudit } from '@/lib/audit';
import { normalizeHandle } from './handle';

/**
 * Data minimisation: the suppression list stores only a salted-by-platform hash
 * of the handle plus a reason. It is enough to refuse future contact and not
 * enough to rebuild a contact base.
 */

export type SuppressionReason = 'opt_out' | 'operator_block' | 'not_interested' | 'complaint';

export function suppressionHash(handle: string, platform = 'instagram'): string {
  return sha256(`${platform}:${normalizeHandle(handle)}`);
}

export function isSuppressed(handle: string, platform = 'instagram', db: Db = getDb()): boolean {
  const row = db
    .select({ id: suppressionList.id })
    .from(suppressionList)
    .where(and(eq(suppressionList.platform, platform), eq(suppressionList.handleHash, suppressionHash(handle, platform))))
    .get();
  return row !== undefined;
}

export interface SuppressInput {
  handle: string;
  platform?: string;
  reason: SuppressionReason;
  source: string;
}

/** Idempotent: suppressing an already-suppressed handle is a no-op. */
export function suppress(input: SuppressInput, db: Db = getDb()): void {
  const platform = input.platform ?? 'instagram';
  const hash = suppressionHash(input.handle, platform);
  const inserted = db
    .insert(suppressionList)
    .values({
      id: newId('sup'),
      platform,
      handleHash: hash,
      reason: input.reason,
      source: input.source,
      createdAt: nowIso(),
    })
    .onConflictDoNothing()
    .run();

  if (inserted.changes > 0) {
    recordAudit(
      {
        actor: 'system',
        action: 'suppression.add',
        entityType: 'suppression',
        entityId: hash,
        after: { reason: input.reason, source: input.source },
        reason: input.reason,
      },
      db,
    );
  }
}

export function suppressionCount(db: Db = getDb()): number {
  const rows = db.select({ id: suppressionList.id }).from(suppressionList).all();
  return rows.length;
}
