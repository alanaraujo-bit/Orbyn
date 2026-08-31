import { closeDb, getDb } from '@/db/client';
import { getEnv } from '@/lib/env';
import { createLogger } from '@/lib/logger';
import { loadBusinessConfig } from '@/config/business';
import { verifyConfigIntegrity } from '@/features/system/config-integrity';
import { capabilityReport } from '@/features/system/capabilities';
import { ensureDefaultExperiments } from '@/features/experiments/seed';
import { startWorker } from './runtime';

const log = createLogger('worker.main');

async function main(): Promise<void> {
  const env = getEnv();
  getDb();

  const { config, fingerprint } = loadBusinessConfig();
  const integrity = verifyConfigIntegrity();
  log.info('business config loaded', {
    company: config.company.name,
    fingerprint: fingerprint.slice(0, 12),
    changedSinceLastRun: integrity.changed,
  });

  for (const capability of capabilityReport()) {
    log.info('capability', {
      id: capability.id,
      usable: capability.usable,
      configured: capability.configured,
      paused: capability.paused,
      missing: capability.missing,
    });
  }

  ensureDefaultExperiments();

  const worker = startWorker();
  log.info('worker loop running', { pollMs: env.WORKER_POLL_INTERVAL_MS });

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    log.info('shutting down', { signal });
    await worker.stop();
    closeDb();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
