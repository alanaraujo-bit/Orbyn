import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { withTestDatabase } from '../helpers/db';
import { getDb } from '@/db/client';
import { leads, messages } from '@/db/schema';
import { resetEnvCache } from '@/lib/env';
import { getBusinessConfig } from '@/config/business';
import { runDiscovery, SimulatedDiscoverySource } from '@/features/leads/discovery';
import { findLeadByHandle, getLead } from '@/features/leads/repository';
import { findConversationByLead, listMessages } from '@/features/conversations/repository';
import { ensureDefaultExperiments } from '@/features/experiments/seed';
import { SimulatedBrowserDriver } from '@/integrations/browser/simulated-driver';
import { runOnce } from '@/worker/runtime';
import { claimNextJob, enqueue, getJob, LEASE_SECONDS, listJobs } from '@/worker/queue';
import type { ApiSender } from '@/features/conversations/inbound';
import { POST as webhookPost } from '@/app/api/webhooks/instagram/route';

/**
 * End-to-end run of the whole commercial pipeline against simulated
 * integrations: discovery -> qualification -> first DM over the (fake) browser
 * -> real webhook route -> handoff -> API reply. Nothing here touches Instagram
 * or OpenAI.
 */

withTestDatabase();

const APP_SECRET = 'segredo-e2e';
const SENDER_ID = '17841400000009999';

beforeEach(() => {
  process.env.CHROME_CDP_URL = 'http://127.0.0.1:9222';
  process.env.INSTAGRAM_APP_SECRET = APP_SECRET;
  process.env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN = 'verify-e2e';
  process.env.INSTAGRAM_PAGE_ACCESS_TOKEN = 'token-e2e';
  process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID = 'business-e2e';
  resetEnvCache();
});

function fakeSender(): ApiSender & { calls: { recipientId: string; text: string }[] } {
  const calls: { recipientId: string; text: string }[] = [];
  const sender = (async (input: { recipientId: string; text: string }) => {
    calls.push(input);
    return { messageId: `mid_out_${calls.length}`, recipientId: input.recipientId };
  }) as ApiSender & { calls: { recipientId: string; text: string }[] };
  sender.calls = calls;
  return sender;
}

/** Drains the queue, with `now` far enough ahead to clear pacing delays. */
async function drain(driver: SimulatedBrowserDriver, sender: ApiSender, maxIterations = 40): Promise<string[]> {
  const log: string[] = [];
  // Stands in for the recurring dispatcher tick. Qualification no longer
  // schedules a send itself: leads wait in `qualified` until the dispatcher
  // finds room for one, so without a tick nothing would ever be contacted.
  enqueue({ type: 'dispatch_outreach' });
  for (let index = 0; index < maxIterations; index += 1) {
    const result = await runOnce({
      dmDriver: driver,
      apiSender: sender,
      now: () => new Date(Date.now() + 5 * 60_000),
      types: ['qualify_lead', 'dispatch_outreach', 'send_first_dm', 'process_inbound'],
    });
    if (!result.ranJob) break;
    log.push(`${result.jobType}:${result.status}`);
  }
  return log;
}

async function deliverWebhook(text: string, mid: string): Promise<Response> {
  const body = JSON.stringify({
    object: 'instagram',
    entry: [
      {
        id: 'business-e2e',
        time: Date.now(),
        messaging: [
          {
            sender: { id: SENDER_ID },
            recipient: { id: 'business-e2e' },
            timestamp: Date.now(),
            message: { mid, text },
          },
        ],
      },
    ],
  });
  const signature = `sha256=${createHmac('sha256', APP_SECRET).update(body, 'utf8').digest('hex')}`;
  return webhookPost(
    new Request('http://127.0.0.1:4310/api/webhooks/instagram', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature },
      body,
    }),
  );
}

const SOURCE = new SimulatedDiscoverySource({
  'automação de processos': [
    {
      handle: 'distribuidora_e2e',
      displayName: 'Distribuidora E2E',
      bio: 'Distribuidora de bebidas. Queremos automação de processos e um sistema empresarial sob medida.',
      category: 'Distribuidora',
      location: 'Belém, Brasil',
      isBusinessAccount: true,
      provenance: { bio: 'instagram_profile_header' },
    },
    {
      handle: 'perfil_fora_do_icp_e2e',
      displayName: 'Fotografia autoral',
      bio: 'Fotos de viagem e natureza.',
      category: null,
      isBusinessAccount: false,
    },
  ],
});

describe('end-to-end pipeline (simulated integrations)', () => {
  it('runs discovery, qualification, first contact, webhook, handoff and reply', async () => {
    ensureDefaultExperiments();
    const driver = new SimulatedBrowserDriver();
    const sender = fakeSender();

    // 1. Discovery, from the official ICP keyword.
    const discovery = await runDiscovery({
      funnel: 'customer',
      source: SOURCE,
      keywords: ['automação de processos'],
    });
    expect(discovery.created).toBe(2);
    expect(discovery.duplicates).toBe(0);

    // Running discovery again must not create a single duplicate.
    const rerun = await runDiscovery({ funnel: 'customer', source: SOURCE, keywords: ['automação de processos'] });
    expect(rerun.created).toBe(0);
    expect(rerun.duplicates).toBe(2);

    // 2 & 3. Worker qualifies and sends the first DM through the browser channel.
    const first = await drain(driver, sender);
    expect(first.filter((entry) => entry.startsWith('qualify_lead')).length).toBe(2);
    expect(driver.delivered).toHaveLength(1);

    const lead = findLeadByHandle('distribuidora_e2e');
    const rejected = findLeadByHandle('perfil_fora_do_icp_e2e');
    expect(lead).toBeDefined();
    expect(rejected?.pipelineStage).toBe('closed');
    if (!lead) throw new Error('unreachable');

    expect(getLead(lead.id).pipelineStage).toBe('contacted');
    expect(getLead(lead.id).channelState).toBe('waiting_inbound_reply');

    // The webhook can only be matched to a lead through the sender id.
    getDb().update(leads).set({ platformUserId: SENDER_ID }).where(eq(leads.id, lead.id)).run();

    // 4. A real signed delivery through the actual route handler.
    const response = await deliverWebhook('Oi! Me manda no whatsapp por favor', 'mid_e2e_1');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accepted: 1, duplicated: 0 });

    // A retried delivery of the same message must be ignored.
    const retry = await deliverWebhook('Oi! Me manda no whatsapp por favor', 'mid_e2e_1');
    expect(await retry.json()).toEqual({ accepted: 0, duplicated: 1 });

    // 5. Worker processes the inbound message.
    await drain(driver, sender);

    const conversation = findConversationByLead(lead.id);
    expect(conversation?.channelOwner).toBe('api');
    expect(conversation?.apiWindowExpiresAt).toBeTruthy();

    const thread = listMessages(conversation?.id ?? '');
    expect(thread.filter((message) => message.direction === 'inbound')).toHaveLength(1);

    // 6. The reply went out through the official API, carrying the real
    // WhatsApp link from config/business.json and nothing else.
    const whatsapp = getBusinessConfig().links.whatsapp;
    expect(sender.calls).toHaveLength(1);
    expect(sender.calls[0]?.recipientId).toBe(SENDER_ID);
    expect(sender.calls[0]?.text).toContain(whatsapp);

    const final = getLead(lead.id);
    expect(['interested', 'whatsapp_handoff']).toContain(final.pipelineStage);

    // The browser sent exactly one message in the whole run.
    const browserMessages = getDb()
      .select()
      .from(messages)
      .where(eq(messages.channel, 'browser'))
      .all();
    expect(browserMessages).toHaveLength(1);
  });

  it('never turns our own account into a lead', async () => {
    const own = getBusinessConfig().company.instagramHandle;
    const result = await runDiscovery({
      funnel: 'customer',
      source: new SimulatedDiscoverySource({ x: [{ handle: own, bio: 'automação de processos' }] }),
      keywords: ['x'],
    });
    expect(result.created).toBe(0);
    expect(result.skippedOwnAccount).toBe(1);
    expect(findLeadByHandle(own)).toBeUndefined();
  });

  it('recovers in-flight work after a worker restart', async () => {
    ensureDefaultExperiments();
    const driver = new SimulatedBrowserDriver();
    const sender = fakeSender();

    await runDiscovery({ funnel: 'customer', source: SOURCE, keywords: ['automação de processos'] });
    expect(listJobs({ statuses: ['pending'], types: ['qualify_lead'] }).length).toBeGreaterThan(0);

    // A worker claims the job and then dies without completing it.
    const target = claimNextJob('worker-that-crashes', new Date(), ['qualify_lead']);
    if (!target) throw new Error('expected a claimable job');
    expect(getJob(target.id).status).toBe('running');
    expect(getJob(target.id).lockedBy).toBe('worker-that-crashes');

    // A fresh worker starting after the lease expired picks the work back up.
    const afterLease = new Date(Date.now() + (LEASE_SECONDS + 10) * 1000);
    const result = await runOnce({
      dmDriver: driver,
      apiSender: sender,
      now: () => afterLease,
      types: ['qualify_lead'],
    });

    expect(result.ranJob).toBe(true);
    expect(result.jobId).toBe(target.id);
    expect(result.status).toBe('succeeded');
    expect(getJob(target.id).status).toBe('succeeded');
  });

  it('does not run a browser job while the capability is paused', async () => {
    const driver = new SimulatedBrowserDriver();
    const sender = fakeSender();
    await runDiscovery({ funnel: 'customer', source: SOURCE, keywords: ['automação de processos'] });
    await drain(driver, sender);
    expect(driver.delivered).toHaveLength(1);

    process.env.CHROME_CDP_URL = '';
    resetEnvCache();

    const lead = findLeadByHandle('distribuidora_e2e');
    if (!lead) throw new Error('unreachable');
    const { job } = enqueue({ type: 'send_first_dm', payload: { leadId: lead.id }, leadId: lead.id });

    const result = await runOnce({ dmDriver: driver, apiSender: sender, types: ['send_first_dm'] });
    expect(result.status).toBe('skipped');
    expect(getJob(job.id).status).toBe('pending');
    expect(driver.delivered).toHaveLength(1);
  });
});
