import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { withTestDatabase } from '../helpers/db';
import { makeLead } from '../helpers/factories';
import { getDb } from '@/db/client';
import { alerts, leads, messages } from '@/db/schema';
import { getLead } from '@/features/leads/repository';
import { sendFirstContact } from '@/features/campaigns/first-contact';
import { dmsSentToday } from '@/features/campaigns/guardrails';
import { SimulatedBrowserDriver } from '@/integrations/browser/simulated-driver';

/**
 * Observed for real on 2026-08-30: a DM was delivered to a real person, then a
 * stage transition threw inside the same transaction and the whole record
 * rolled back. The message was gone from the database while sitting in the
 * recipient's inbox — and a retry would have delivered a second one.
 *
 * The rule these tests pin: once the provider accepted the message, the record
 * of it survives any later bookkeeping failure.
 */

withTestDatabase();

describe('durability of a completed send', () => {
  it('keeps the message and the counter when the stage cannot advance', async () => {
    const lead = makeLead();
    // Close the lead, so the post-send transition to `contacted` is illegal.
    getDb().update(leads).set({ pipelineStage: 'closed' }).where(eq(leads.id, lead.id)).run();

    const driver = new SimulatedBrowserDriver();
    const result = await sendFirstContact({ leadId: lead.id, mode: 'simulated', driver, jobId: 'job_x' });

    // The send happened and is reported as such.
    expect(result.status).toBe('sent');
    expect(driver.delivered).toHaveLength(1);

    // And it is durably recorded, despite the illegal transition.
    const stored = getDb().select().from(messages).where(eq(messages.leadId, lead.id)).all();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.channel).toBe('browser');

    // Pacing counted it, so the daily cap cannot drift.
    expect(dmsSentToday()).toBe(1);

    // The mismatch is surfaced rather than hidden.
    const open = getDb().select().from(alerts).where(eq(alerts.status, 'open')).all();
    expect(open.some((a) => a.code === 'post_send_state_mismatch')).toBe(true);
  });

  it('never delivers twice after a bookkeeping failure', async () => {
    const lead = makeLead();
    getDb().update(leads).set({ pipelineStage: 'closed' }).where(eq(leads.id, lead.id)).run();

    const driver = new SimulatedBrowserDriver();
    await sendFirstContact({ leadId: lead.id, mode: 'simulated', driver, jobId: 'job_x' });
    expect(driver.delivered).toHaveLength(1);

    // The retry a worker would perform must not reach the driver again.
    await expect(
      sendFirstContact({
        leadId: lead.id,
        mode: 'simulated',
        driver,
        jobId: 'job_x',
        now: new Date(Date.now() + 60_000),
      }),
    ).rejects.toMatchObject({ code: 'channel_ownership_conflict' });

    expect(driver.delivered).toHaveLength(1);
    expect(getDb().select().from(messages).where(eq(messages.leadId, lead.id)).all()).toHaveLength(1);
  });

  it('still advances both machines on the normal path', async () => {
    const lead = makeLead();
    const driver = new SimulatedBrowserDriver();

    const result = await sendFirstContact({ leadId: lead.id, mode: 'simulated', driver, jobId: 'job_ok' });

    expect(result.status).toBe('sent');
    const updated = getLead(lead.id);
    expect(updated.pipelineStage).toBe('contacted');
    expect(updated.channelState).toBe('waiting_inbound_reply');
    const open = getDb().select().from(alerts).where(eq(alerts.status, 'open')).all();
    expect(open.some((a) => a.code === 'post_send_state_mismatch')).toBe(false);
  });
});
