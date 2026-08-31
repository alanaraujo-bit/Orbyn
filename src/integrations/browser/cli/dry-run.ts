import { getDb } from '@/db/client';
import { getEnv } from '@/lib/env';
import { newId } from '@/lib/ids';
import { normalizeHandle } from '@/features/leads/handle';
import { findLeadByHandle, registerDiscoveredLead, qualifyLead } from '@/features/leads/repository';
import { isCapabilityUsable } from '@/features/system/capabilities';
import { ensureDefaultExperiments } from '@/features/experiments/seed';
import { sendFirstContact } from '@/features/campaigns/first-contact';
import { InstagramBrowserDriver } from '@/integrations/browser/instagram-dm';
import { SimulatedBrowserDriver } from '@/integrations/browser/simulated-driver';
import type { DmDriver, DmMode } from '@/integrations/browser/types';

/**
 * Dry run: exercises the whole first-contact path (guards, policy, ownership,
 * navigation) and stops immediately before the send. It can never deliver a
 * message - `mode: 'dry_run'` is checked inside the driver itself.
 *
 * Usage: pnpm dryrun:dm <@handle>
 */

async function main(): Promise<void> {
  const handleArg = process.argv[2];
  if (!handleArg) {
    console.error('Uso: pnpm dryrun:dm <@handle>');
    process.exit(1);
  }

  const handle = normalizeHandle(handleArg);
  getDb();
  ensureDefaultExperiments();

  let lead = findLeadByHandle(handle);
  if (!lead) {
    const created = registerDiscoveredLead({
      handle,
      funnel: 'customer',
      discoverySource: 'dry_run_cli',
      bio: null,
      category: null,
    });
    if (created.status !== 'created') {
      console.error(`Não foi possível preparar o lead: ${created.status}`);
      process.exit(1);
    }
    lead = created.lead;
  }

  if (lead.pipelineStage === 'discovered') {
    const qualification = qualifyLead(lead.id);
    console.log(`Qualificação: score ${qualification.score} (${qualification.qualified ? 'dentro' : 'fora'} do ICP)`);
    lead = qualification.lead;
  }

  const browserAvailable = isCapabilityUsable('browser_outreach');
  const driver: DmDriver = browserAvailable ? new InstagramBrowserDriver() : new SimulatedBrowserDriver();
  const mode: DmMode = 'dry_run';

  console.log('');
  console.log(`Driver:   ${driver.name}${browserAvailable ? '' : ' (Chrome indisponível — páginas simuladas)'}`);
  console.log(`Modo:     ${mode}`);
  console.log(`CDP:      ${getEnv().CHROME_CDP_URL ?? 'não configurado'}`);
  console.log('');

  const result = await sendFirstContact({ leadId: lead.id, mode, driver, jobId: newId('dryrun') });

  console.log(`Resultado: ${result.status}`);
  if (result.detail) console.log(`Detalhe:   ${result.detail}`);
  if (result.evidence?.url) console.log(`URL final: ${result.evidence.url}`);
  if (result.evidence?.screenshotPath) console.log(`Screenshot: ${result.evidence.screenshotPath}`);
  if (result.evidence?.accessibilitySnapshotPath) {
    console.log(`Snapshot:   ${result.evidence.accessibilitySnapshotPath}`);
  }
  if (result.message) {
    console.log('');
    console.log('Mensagem que SERIA enviada:');
    console.log('---');
    console.log(result.message);
    console.log('---');
  }
  console.log('');
  console.log('Nenhuma mensagem foi enviada.');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
