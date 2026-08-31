import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { sha256 } from '@/lib/ids';

/**
 * Versioned, checksummed migrations. Files are applied in filename order inside
 * a transaction; an already-applied file whose contents changed is a hard error
 * rather than a silent divergence.
 */

// Resolved from the repository root so it works identically under `next` and `tsx`.
const MIGRATIONS_DIR = path.resolve(process.cwd(), 'src', 'db', 'migrations');

export interface MigrationFile {
  name: string;
  sql: string;
  checksum: string;
}

export function readMigrationFiles(dir: string = MIGRATIONS_DIR): MigrationFile[] {
  const entries = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b, 'en'));
  return entries.map((name) => {
    const sql = fs.readFileSync(path.join(dir, name), 'utf8');
    return { name, sql, checksum: sha256(sql) };
  });
}

interface AppliedRow {
  name: string;
  checksum: string;
}

export interface MigrationResult {
  applied: string[];
  alreadyApplied: string[];
}

export function runMigrations(sqlite: Database.Database, dir: string = MIGRATIONS_DIR): MigrationResult {
  sqlite.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       name TEXT PRIMARY KEY,
       checksum TEXT NOT NULL,
       applied_at TEXT NOT NULL
     );`,
  );

  const applied = new Map<string, string>();
  for (const row of sqlite.prepare('SELECT name, checksum FROM schema_migrations').all() as AppliedRow[]) {
    applied.set(row.name, row.checksum);
  }

  const result: MigrationResult = { applied: [], alreadyApplied: [] };

  for (const migration of readMigrationFiles(dir)) {
    const known = applied.get(migration.name);
    if (known !== undefined) {
      if (known !== migration.checksum) {
        throw new Error(
          `Migration "${migration.name}" changed after being applied. Create a new migration instead of editing history.`,
        );
      }
      result.alreadyApplied.push(migration.name);
      continue;
    }
    const apply = sqlite.transaction(() => {
      sqlite.exec(migration.sql);
      sqlite
        .prepare('INSERT INTO schema_migrations (name, checksum, applied_at) VALUES (?, ?, ?)')
        .run(migration.name, migration.checksum, new Date().toISOString());
    });
    apply.immediate();
    result.applied.push(migration.name);
  }

  return result;
}
