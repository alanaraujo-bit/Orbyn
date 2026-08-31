import { getDb } from '@/db/client';
import { newId } from '@/lib/ids';
import { addHours, nowIso } from '@/lib/time';
import { qualifyLead, registerDiscoveredLead, transitionChannel, transitionStage } from '@/features/leads/repository';
import { ensureConversation } from '@/features/conversations/repository';
import { recordInboundMessage, recordOutboundMessage } from '@/features/conversations/messages';
import { ensureDefaultExperiments } from '@/features/experiments/seed';
import { DEMO_DISCOVERY_SOURCE } from '@/features/campaigns/first-contact';
import { conversations } from '@/db/schema';
import { eq } from 'drizzle-orm';

/**
 * Populates the panel with clearly-labelled demo records so the operator can
 * evaluate the interface before pointing it at real profiles. Demo leads are
 * refused by the live outreach path by construction.
 *
 * Usage: pnpm seed:demo
 */

const DEMO_PROFILES = [
  {
    handle: 'demo_distribuidora_norte',
    displayName: 'Distribuidora Norte',
    bio: 'Distribuidora de bebidas e água mineral. Queremos automação de processos e um sistema empresarial próprio.',
    category: 'Distribuidora',
    location: 'Belém, Brasil',
    stage: 'contacted' as const,
  },
  {
    handle: 'demo_mercado_central',
    displayName: 'Mercado Central',
    bio: 'Mercado de bairro. Precisamos melhorar a gestão empresarial e o controle de estoque.',
    category: 'Mercado',
    location: 'Marabá, Brasil',
    stage: 'replied' as const,
  },
  {
    handle: 'demo_oficina_toledo',
    displayName: 'Oficina Toledo',
    bio: 'Manutenção automotiva. Buscamos um sistema empresarial para automação de processos da oficina.',
    category: 'Serviço automotivo',
    location: 'Canaã dos Carajás, Brasil',
    stage: 'qualified' as const,
  },
  {
    handle: 'demo_moda_ateliê',
    displayName: 'Ateliê de Moda',
    bio: 'Moda autoral, peças sob encomenda.',
    category: 'Moda',
    location: 'Belém, Brasil',
    stage: 'discovered' as const,
  },
];

async function main(): Promise<void> {
  const db = getDb();
  ensureDefaultExperiments(db);

  let created = 0;
  for (const profile of DEMO_PROFILES) {
    const handle = profile.handle.replace(/[^a-z0-9._]/g, '_');
    const outcome = registerDiscoveredLead({
      handle,
      displayName: profile.displayName,
      bio: profile.bio,
      category: profile.category,
      location: profile.location,
      funnel: 'customer',
      discoverySource: DEMO_DISCOVERY_SOURCE,
      sourceKeyword: 'gestão empresarial',
      isBusinessAccount: true,
    });
    if (outcome.status !== 'created') continue;
    created += 1;

    const leadId = outcome.lead.id;
    if (profile.stage === 'discovered') continue;

    const qualification = qualifyLead(leadId, db);
    if (!qualification.qualified) {
      console.log(`Lead de demonstração @${handle} ficou fora do ICP (score ${qualification.score}).`);
      continue;
    }
    if (profile.stage === 'qualified') continue;

    const conversation = ensureConversation(leadId, 'customer', db);
    transitionChannel({ leadId, to: 'browser_contact_sent', actor: 'system', reason: 'demonstração' }, db);
    transitionChannel({ leadId, to: 'waiting_inbound_reply', actor: 'system', reason: 'demonstração' }, db);
    transitionStage({ leadId, to: 'contacted', actor: 'system', reason: 'demonstração' }, db);
    recordOutboundMessage(
      {
        conversationId: conversation.id,
        leadId,
        channel: 'browser',
        body: `Oi! Vi aqui no perfil que vocês trabalham com ${profile.category?.toLowerCase()}. Sou Alan, da Aionixdev — a gente desenvolve software sob medida para empresas. Hoje a operação de vocês roda em algum sistema próprio?`,
        idempotencyKey: newId('demo'),
        jobId: null,
        meta: { generator: 'template', demo: true },
      },
      db,
    );

    if (profile.stage !== 'replied') continue;

    transitionChannel({ leadId, to: 'api_eligible', actor: 'system', reason: 'demonstração' }, db);
    transitionStage({ leadId, to: 'replied', actor: 'system', reason: 'demonstração' }, db);
    db.update(conversations)
      .set({ channelOwner: 'api', apiWindowExpiresAt: addHours(new Date(), 20).toISOString(), updatedAt: nowIso() })
      .where(eq(conversations.id, conversation.id))
      .run();
    recordInboundMessage(
      {
        conversationId: conversation.id,
        leadId,
        body: 'Oi! Hoje a gente usa planilha mesmo. Como funciona o trabalho de vocês?',
        externalMessageId: newId('demo_mid'),
        receivedAt: nowIso(),
      },
      db,
    );
  }

  console.log(`Leads de demonstração criados: ${created}`);
  console.log('Estes registros nunca recebem contato real (discoverySource = demo_seed).');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
