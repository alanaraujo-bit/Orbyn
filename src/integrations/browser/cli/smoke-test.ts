import readline from 'node:readline/promises';
import { getDb } from '@/db/client';
import { getEnv } from '@/lib/env';
import { newId } from '@/lib/ids';
import { normalizeHandle } from '@/features/leads/handle';
import { findLeadByHandle, qualifyLead, registerDiscoveredLead } from '@/features/leads/repository';
import { isCapabilityUsable } from '@/features/system/capabilities';
import { ensureDefaultExperiments } from '@/features/experiments/seed';
import { sendFirstContact } from '@/features/campaigns/first-contact';
import { InstagramBrowserDriver } from '@/integrations/browser/instagram-dm';

/**
 * Real, limited smoke test: sends exactly one real DM.
 *
 * Three independent authorisations are required, so no automated run can ever
 * trip it: ALLOW_REAL_DM_SMOKE_TEST=true in `.env`, the
 * `--i-authorize-real-dm` flag, and a typed confirmation at the prompt.
 *
 * Usage: pnpm smoke:dm -- --handle @alguem --i-authorize-real-dm
 */

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

async function main(): Promise<void> {
  const env = getEnv();
  const handleArg = argValue('handle');
  const authorized = process.argv.includes('--i-authorize-real-dm');

  if (!handleArg) {
    console.error('Uso: pnpm smoke:dm -- --handle <@handle> --i-authorize-real-dm');
    process.exit(1);
  }
  if (!env.ALLOW_REAL_DM_SMOKE_TEST) {
    console.error('Bloqueado: defina ALLOW_REAL_DM_SMOKE_TEST=true no .env para habilitar o smoke test real.');
    process.exit(1);
  }
  if (!authorized) {
    console.error('Bloqueado: a flag --i-authorize-real-dm é obrigatória.');
    process.exit(1);
  }
  if (!isCapabilityUsable('browser_outreach')) {
    console.error('Bloqueado: capacidade de navegador indisponível ou pausada.');
    process.exit(1);
  }

  const handle = normalizeHandle(handleArg);
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await prompt.question(
    `\nIsto vai ENVIAR UMA DM REAL para @${handle} pela conta conectada no Chrome.\nDigite exatamente "ENVIAR" para confirmar: `,
  );
  prompt.close();

  if (answer.trim() !== 'ENVIAR') {
    console.log('Cancelado. Nenhuma mensagem foi enviada.');
    process.exit(0);
  }

  getDb();
  ensureDefaultExperiments();

  let lead = findLeadByHandle(handle);
  if (!lead) {
    const created = registerDiscoveredLead({
      handle,
      funnel: 'customer',
      discoverySource: 'smoke_test_cli',
    });
    if (created.status !== 'created') {
      console.error(`Não foi possível preparar o lead: ${created.status}`);
      process.exit(1);
    }
    lead = created.lead;
  }
  if (lead.pipelineStage === 'discovered') lead = qualifyLead(lead.id).lead;

  const result = await sendFirstContact({
    leadId: lead.id,
    mode: 'live',
    driver: new InstagramBrowserDriver(),
    jobId: newId('smoke'),
  });

  console.log(`\nResultado: ${result.status}`);
  if (result.detail) console.log(`Detalhe:   ${result.detail}`);
  if (result.message) console.log(`Mensagem:  ${result.message}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
