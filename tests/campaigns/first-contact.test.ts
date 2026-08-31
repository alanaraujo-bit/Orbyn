import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { withTestDatabase } from '../helpers/db';
import { makeLead } from '../helpers/factories';
import { getDb } from '@/db/client';
import { messages } from '@/db/schema';
import { getLead } from '@/features/leads/repository';
import { findConversationByLead } from '@/features/conversations/repository';
import { evaluateSendGuard } from '@/features/conversations/channel';
import { sendFirstContact } from '@/features/campaigns/first-contact';
import { dmsSentToday } from '@/features/campaigns/guardrails';
import { capabilityReport } from '@/features/system/capabilities';
import { SimulatedBrowserDriver } from '@/integrations/browser/simulated-driver';
import { ensureDefaultExperiments } from '@/features/experiments/seed';

withTestDatabase();

function driver(): SimulatedBrowserDriver {
  return new SimulatedBrowserDriver();
}

describe('first contact over the browser', () => {
  it('sends once, records the message and advances both state machines', async () => {
    ensureDefaultExperiments();
    const lead = makeLead();
    const dm = driver();

    const result = await sendFirstContact({ leadId: lead.id, mode: 'simulated', driver: dm, jobId: 'job_1' });

    expect(result.status).toBe('sent');
    expect(dm.delivered).toHaveLength(1);
    expect(dm.delivered[0]?.handle).toBe(lead.handle);

    const updated = getLead(lead.id);
    expect(updated.pipelineStage).toBe('contacted');
    expect(updated.channelState).toBe('waiting_inbound_reply');
    expect(updated.channelOwner).toBe('none');
    expect(dmsSentToday()).toBe(1);
  });

  it('assigns a variant of the running opener experiment', async () => {
    ensureDefaultExperiments();
    const lead = makeLead();
    await sendFirstContact({ leadId: lead.id, mode: 'simulated', driver: driver(), jobId: 'job_variant' });

    const stored = getDb().select().from(messages).where(eq(messages.leadId, lead.id)).all();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.variantId).not.toBeNull();
    expect(stored[0]?.experimentId).not.toBeNull();
  });

  it('never sends the first DM twice for the same lead', async () => {
    const lead = makeLead();
    const dm = driver();

    const first = await sendFirstContact({ leadId: lead.id, mode: 'simulated', driver: dm, jobId: 'job_a' });
    expect(first.status).toBe('sent');

    // A retried job must not deliver again: the channel no longer belongs to
    // the browser. `now` is pushed past the pacing gap so ownership - not
    // pacing - is what stops the second attempt.
    await expect(
      sendFirstContact({
        leadId: lead.id,
        mode: 'simulated',
        driver: dm,
        jobId: 'job_a',
        now: new Date(Date.now() + 60_000),
      }),
    ).rejects.toMatchObject({ code: 'channel_ownership_conflict' });

    expect(dm.delivered).toHaveLength(1);
    expect(getDb().select().from(messages).where(eq(messages.leadId, lead.id)).all()).toHaveLength(1);
  });

  it('a dry run reaches the composer and delivers nothing', async () => {
    const lead = makeLead();
    const dm = driver();

    const result = await sendFirstContact({ leadId: lead.id, mode: 'dry_run', driver: dm, jobId: 'job_dry' });

    expect(result.status).toBe('dry_run_ok');
    expect(result.message).toBeTruthy();
    expect(dm.delivered).toHaveLength(0);
    expect(getDb().select().from(messages).where(eq(messages.leadId, lead.id)).all()).toHaveLength(0);
    expect(getLead(lead.id).pipelineStage).toBe('qualified');
  });

  it('pauses the browser capability on an Instagram safety signal and sends nothing', async () => {
    const lead = makeLead();
    const dm = driver();
    dm.setProfileState(lead.handle, { kind: 'challenge', text: 'Ação bloqueada. Tente novamente mais tarde.' });

    const result = await sendFirstContact({ leadId: lead.id, mode: 'simulated', driver: dm, jobId: 'job_safety' });

    expect(result.status).toBe('safety_paused');
    expect(dm.delivered).toHaveLength(0);
    const browser = capabilityReport().find((entry) => entry.id === 'browser_outreach');
    expect(browser?.paused).toBe(true);
    expect(getLead(lead.id).pipelineStage).toBe('qualified');
  });

  it('closes the lead when the profile does not exist', async () => {
    const lead = makeLead();
    const dm = driver();
    dm.setProfileState(lead.handle, { kind: 'not_found' });

    const result = await sendFirstContact({ leadId: lead.id, mode: 'simulated', driver: dm, jobId: 'job_404' });

    expect(result.status).toBe('profile_not_found');
    expect(getLead(lead.id).pipelineStage).toBe('closed');
  });
});

describe('send guard', () => {
  it('refuses the API while the browser owns the thread and vice versa', async () => {
    const lead = makeLead();
    await sendFirstContact({ leadId: lead.id, mode: 'simulated', driver: driver(), jobId: 'job_guard' });

    const conversation = findConversationByLead(lead.id);
    expect(conversation).toBeDefined();
    if (!conversation) throw new Error('unreachable');

    const current = getLead(lead.id);
    expect(evaluateSendGuard({ lead: current, conversation, channel: 'api' }).allowed).toBe(false);
    expect(evaluateSendGuard({ lead: current, conversation, channel: 'browser' }).allowed).toBe(false);
  });
});
