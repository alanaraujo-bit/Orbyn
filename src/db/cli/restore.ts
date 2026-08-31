import { closeDb, getDb } from '@/db/client';
import { listBackups, restoreBackup, verifyBackup } from '@/db/backup';

const target = process.argv[2] ?? listBackups()[0]?.file;

if (!target) {
  console.error('Nenhum backup encontrado. Uso: pnpm db:restore <caminho-do-backup>');
  process.exit(1);
}

const check = verifyBackup(target);
if (!check.ok) {
  console.error(`Backup inválido: ${check.problem ?? 'motivo desconhecido'}`);
  process.exit(1);
}

getDb();
const result = restoreBackup(target, closeDb);

console.log(`Restaurado de: ${result.restoredFrom}`);
console.log(`Cópia de segurança do banco anterior: ${result.safetyCopy}`);
console.log(`Tabelas verificadas: ${result.tables}`);
