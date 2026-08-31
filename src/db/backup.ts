import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { databaseFilePath, getEnv } from '@/lib/env';
import { getSqlite } from './client';
import { createLogger } from '@/lib/logger';
import { runMigrations } from './migrator';

const log = createLogger('db.backup');

/**
 * Online backup via SQLite's own backup API, so a copy taken while the worker
 * is writing is still consistent. Restores are verified before they replace the
 * live file.
 */

export function backupDir(): string {
  // Operator-configured directory, resolved from the repository root by design.
  const dir = path.resolve(/* turbopackIgnore: true */ process.cwd(), getEnv().BACKUP_DIR);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export interface BackupResult {
  file: string;
  bytes: number;
  createdAt: string;
}

export async function createBackup(): Promise<BackupResult> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = path.join(backupDir(), `orbyn-${stamp}.db`);
  await getSqlite().backup(target);
  const stats = fs.statSync(target);
  log.info('backup created', { file: target, bytes: stats.size });
  return { file: target, bytes: stats.size, createdAt: new Date().toISOString() };
}

export function listBackups(): BackupResult[] {
  const dir = backupDir();
  return fs
    .readdirSync(/* turbopackIgnore: true */ dir)
    .filter((name) => name.endsWith('.db'))
    .map((name) => {
      const file = path.join(dir, name);
      const stats = fs.statSync(/* turbopackIgnore: true */ file);
      return { file, bytes: stats.size, createdAt: stats.mtime.toISOString() };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Removes backups beyond `keep`, newest first. */
export function pruneBackups(keep: number): string[] {
  const removed: string[] = [];
  for (const backup of listBackups().slice(keep)) {
    fs.unlinkSync(backup.file);
    removed.push(backup.file);
  }
  return removed;
}

export interface RestoreCheck {
  ok: boolean;
  tables: number;
  problem?: string;
}

/** Opens a backup read-only and checks it is a usable Orbyn database. */
export function verifyBackup(file: string): RestoreCheck {
  let database: Database.Database | undefined;
  try {
    database = new Database(file, { readonly: true });
    const integrity = database.pragma('integrity_check', { simple: true });
    if (integrity !== 'ok') return { ok: false, tables: 0, problem: `integrity_check: ${String(integrity)}` };
    const rows = database
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[];
    const names = new Set(rows.map((row) => row.name));
    for (const required of ['leads', 'conversations', 'messages', 'jobs', 'schema_migrations']) {
      if (!names.has(required)) return { ok: false, tables: names.size, problem: `tabela ausente: ${required}` };
    }
    return { ok: true, tables: names.size };
  } catch (error) {
    return { ok: false, tables: 0, problem: error instanceof Error ? error.message : String(error) };
  } finally {
    database?.close();
  }
}

export interface RestoreResult {
  restoredFrom: string;
  safetyCopy: string;
  tables: number;
}

/**
 * Replaces the live database with a backup. The current database is copied
 * aside first, so a restore is itself reversible.
 */
export function restoreBackup(file: string, closeLive: () => void): RestoreResult {
  const check = verifyBackup(file);
  if (!check.ok) {
    throw new Error(`Backup inválido (${file}): ${check.problem ?? 'motivo desconhecido'}`);
  }

  const live = databaseFilePath();
  closeLive();

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safetyCopy = path.join(backupDir(), `pre-restore-${stamp}.db`);
  if (fs.existsSync(live)) fs.copyFileSync(live, safetyCopy);

  for (const suffix of ['-wal', '-shm']) {
    const sidecar = `${live}${suffix}`;
    if (fs.existsSync(/* turbopackIgnore: true */ sidecar)) fs.unlinkSync(sidecar);
  }
  fs.copyFileSync(file, live);

  const reopened = new Database(live);
  reopened.pragma('journal_mode = WAL');
  reopened.pragma('foreign_keys = ON');
  runMigrations(reopened);
  reopened.close();

  log.info('database restored', { from: file, safetyCopy });
  return { restoredFrom: file, safetyCopy, tables: check.tables };
}
