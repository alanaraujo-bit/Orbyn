import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach } from 'vitest';
import { closeDb, getDb, openDatabase, setDbForTesting, type Db } from '@/db/client';
import { resetEnvCache } from '@/lib/env';

/**
 * Each test gets its own on-disk SQLite database so migrations, WAL and
 * transactions behave exactly as they do in production.
 */
export function withTestDatabase(): { db: () => Db } {
  let file = '';

  beforeEach(() => {
    file = path.join(os.tmpdir(), `orbyn-test-${randomUUID()}.db`);
    process.env.DATABASE_URL = `file:${file}`;
    resetEnvCache();
    setDbForTesting(openDatabase(file));
  });

  afterEach(() => {
    closeDb();
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        fs.unlinkSync(`${file}${suffix}`);
      } catch {
        // best effort cleanup
      }
    }
  });

  return { db: () => getDb() };
}
