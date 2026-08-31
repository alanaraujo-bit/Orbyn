import { desc, eq } from 'drizzle-orm';
import { getDb, type Db } from '@/db/client';
import { configFingerprints } from '@/db/schema';
import { newId } from '@/lib/ids';
import { nowIso } from '@/lib/time';
import { raiseAlert, recordAudit } from '@/lib/audit';
import { loadBusinessConfig } from '@/config/business';

/**
 * Integrity of the operator-owned business record.
 *
 * `config/business.json` is never written by this codebase - there is no code
 * path that opens it for writing. What this module adds is detection: every
 * start records the file's content hash, and a change between runs is reported
 * as an audited operator action rather than passing silently.
 */

export const CONFIG_SOURCE = 'config/business.json';

export interface IntegrityResult {
  fingerprint: string;
  previousFingerprint: string | null;
  changed: boolean;
  firstRun: boolean;
}

export function verifyConfigIntegrity(db: Db = getDb()): IntegrityResult {
  const { fingerprint } = loadBusinessConfig();
  const previous = db
    .select()
    .from(configFingerprints)
    .where(eq(configFingerprints.source, CONFIG_SOURCE))
    .orderBy(desc(configFingerprints.seenAt))
    .limit(1)
    .get();

  const firstRun = previous === undefined;
  const changed = !firstRun && previous.fingerprint !== fingerprint;

  if (firstRun || changed) {
    db.insert(configFingerprints)
      .values({ id: newId('cfg'), source: CONFIG_SOURCE, fingerprint, seenAt: nowIso() })
      .run();
    recordAudit(
      {
        actor: 'operator',
        action: firstRun ? 'config.registered' : 'config.changed',
        entityType: 'business_config',
        entityId: CONFIG_SOURCE,
        before: previous ? { fingerprint: previous.fingerprint } : undefined,
        after: { fingerprint },
        reason: firstRun ? 'primeira leitura' : 'arquivo alterado pelo operador',
      },
      db,
    );
  }

  if (changed) {
    raiseAlert(
      {
        kind: 'data_integrity',
        severity: 'info',
        code: 'business_config_changed',
        title: 'Cadastro oficial do negócio foi alterado',
        detail: 'config/business.json mudou desde a última execução. Revise claims, links e ICP.',
        context: { fingerprint: fingerprint.slice(0, 12) },
        dedupeKey: `config:${fingerprint.slice(0, 12)}`,
      },
      db,
    );
  }

  return {
    fingerprint,
    previousFingerprint: previous?.fingerprint ?? null,
    changed,
    firstRun,
  };
}
