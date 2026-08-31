import { createBackup, listBackups, pruneBackups } from '@/db/backup';
import { getDb } from '@/db/client';

getDb();

const result = await createBackup();
const pruned = pruneBackups(14);

console.log(`Backup criado: ${result.file}`);
console.log(`Tamanho: ${(result.bytes / 1024).toFixed(1)} KB`);
if (pruned.length > 0) console.log(`Backups antigos removidos: ${pruned.length}`);
console.log(`Total de backups: ${listBackups().length}`);
