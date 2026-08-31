import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { withTestDatabase } from '../helpers/db';
import { makeLead } from '../helpers/factories';
import { closeDb, getDb, getSqlite } from '@/db/client';
import { readMigrationFiles, runMigrations } from '@/db/migrator';
import { createBackup, restoreBackup, verifyBackup } from '@/db/backup';
import * as schema from '@/db/schema';
import { getTableName, getTableColumns, is } from 'drizzle-orm';
import { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { findLeadByHandle } from '@/features/leads/repository';
import { anonymizeExpiredLeads } from '@/features/privacy/retention';
import { leads } from '@/db/schema';
import { eq } from 'drizzle-orm';

withTestDatabase();

describe('migrations', () => {
  it('applies every file once and refuses to re-run a modified one', () => {
    const sqlite = getSqlite();
    const second = runMigrations(sqlite);
    expect(second.applied).toHaveLength(0);
    expect(second.alreadyApplied.length).toBeGreaterThan(0);
  });

  it('rejects an edited migration instead of silently diverging', () => {
    const dir = fs.mkdtempSync(path.join(process.cwd(), 'data', 'mig-'));
    try {
      fs.writeFileSync(path.join(dir, '0001_x.sql'), 'CREATE TABLE t (id TEXT PRIMARY KEY);');
      const sqlite = getSqlite();
      runMigrations(sqlite, dir);
      fs.writeFileSync(path.join(dir, '0001_x.sql'), 'CREATE TABLE t (id TEXT PRIMARY KEY, extra TEXT);');
      expect(() => runMigrations(sqlite, dir)).toThrow(/changed after being applied/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the Drizzle schema and the SQL migrations in sync', () => {
    const sqlite = getSqlite();
    const tables = new Map<string, Set<string>>();
    for (const row of sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[]) {
      const columns = sqlite.prepare(`PRAGMA table_info(${row.name})`).all() as { name: string }[];
      tables.set(row.name, new Set(columns.map((column) => column.name)));
    }

    const drizzleTables: SQLiteTable[] = [];
    for (const value of Object.values(schema)) {
      if (is(value, SQLiteTable)) drizzleTables.push(value as SQLiteTable);
    }

    expect(drizzleTables.length).toBeGreaterThan(15);
    for (const table of drizzleTables) {
      const name = getTableName(table);
      const actual = tables.get(name);
      expect(actual, `tabela ${name} não existe no banco`).toBeDefined();
      for (const column of Object.values(getTableColumns(table))) {
        expect(actual?.has(column.name), `${name}.${column.name} ausente no banco`).toBe(true);
      }
    }
  });

  it('ships at least one migration file', () => {
    expect(readMigrationFiles().length).toBeGreaterThan(0);
  });
});

describe('backup and restore', () => {
  it('creates a verifiable backup and restores it', async () => {
    const lead = makeLead({ handle: 'antes_do_backup' });
    const backup = await createBackup();

    expect(verifyBackup(backup.file).ok).toBe(true);

    // Change the live database after the backup was taken.
    getDb().delete(leads).where(eq(leads.id, lead.id)).run();
    expect(findLeadByHandle('antes_do_backup')).toBeUndefined();

    const result = restoreBackup(backup.file, closeDb);
    expect(result.tables).toBeGreaterThan(15);
    expect(fs.existsSync(result.safetyCopy)).toBe(true);
    expect(findLeadByHandle('antes_do_backup')).toBeDefined();

    fs.unlinkSync(backup.file);
    fs.unlinkSync(result.safetyCopy);
  });

  it('refuses to restore a file that is not an Orbyn database', () => {
    const bogus = path.join(process.cwd(), 'data', 'bogus.db');
    fs.writeFileSync(bogus, 'not a database');
    try {
      expect(verifyBackup(bogus).ok).toBe(false);
      expect(() => restoreBackup(bogus, closeDb)).toThrow(/Backup inválido/);
    } finally {
      fs.unlinkSync(bogus);
    }
  });
});

describe('retention', () => {
  it('anonymises an expired lead and clears the message bodies', () => {
    const lead = makeLead({ handle: 'expirado_teste' });
    getDb()
      .update(leads)
      .set({ retentionExpiresAt: new Date(Date.now() - 1000).toISOString() })
      .where(eq(leads.id, lead.id))
      .run();

    const result = anonymizeExpiredLeads();
    expect(result.anonymized).toBe(1);

    const stored = getDb().select().from(leads).where(eq(leads.id, lead.id)).get();
    expect(stored?.handle.startsWith('anon_')).toBe(true);
    expect(stored?.bio).toBeNull();
    expect(stored?.displayName).toBeNull();
  });

  it('never anonymises an active customer', () => {
    const lead = makeLead({ handle: 'cliente_ativo_teste' });
    getDb()
      .update(leads)
      .set({ pipelineStage: 'active_customer', retentionExpiresAt: new Date(Date.now() - 1000).toISOString() })
      .where(eq(leads.id, lead.id))
      .run();

    expect(anonymizeExpiredLeads().anonymized).toBe(0);
  });
});
