import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { databaseFilePath } from '@/lib/env';
import { runMigrations } from './migrator';
import * as schema from './schema';

export type Db = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

interface Handle {
  sqlite: Database.Database;
  db: Db;
  file: string;
}

const globalRef = globalThis as typeof globalThis & { __orbynDb?: Handle };

function applyPragmas(sqlite: Database.Database): void {
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
}

export function openDatabase(file: string): Handle {
  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  const sqlite = new Database(file);
  applyPragmas(sqlite);
  runMigrations(sqlite);
  const db = drizzle(sqlite, { schema }) as Db;
  return { sqlite, db, file };
}

export function getDb(): Db {
  const target = databaseFilePath();
  const existing = globalRef.__orbynDb;
  if (existing && existing.file === target) return existing.db;
  if (existing) existing.sqlite.close();
  const handle = openDatabase(target);
  globalRef.__orbynDb = handle;
  return handle.db;
}

export function getSqlite(): Database.Database {
  getDb();
  const handle = globalRef.__orbynDb;
  if (!handle) throw new Error('database handle unavailable');
  return handle.sqlite;
}

export function closeDb(): void {
  const existing = globalRef.__orbynDb;
  if (!existing) return;
  existing.sqlite.close();
  globalRef.__orbynDb = undefined;
}

/** Test seam: bind the process-wide handle to an already-open database. */
export function setDbForTesting(handle: Handle): void {
  globalRef.__orbynDb = handle;
}

/**
 * Runs `fn` inside an IMMEDIATE transaction. Every state change that must be
 * all-or-nothing (send + counter + event + audit) goes through here.
 */
export function transact<T>(fn: (db: Db) => T): T {
  const db = getDb();
  const sqlite = getSqlite();
  const wrapped = sqlite.transaction(() => fn(db));
  return wrapped.immediate();
}
