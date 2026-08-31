import { getDb, getSqlite } from '@/db/client';
import { databaseFilePath } from '@/lib/env';

getDb();
const sqlite = getSqlite();
const tables = sqlite
  .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .all() as { name: string }[];

console.log(`Banco: ${databaseFilePath()}`);
console.log(`Tabelas (${tables.length}): ${tables.map((t) => t.name).join(', ')}`);
