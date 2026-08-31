import { beforeEach, describe, expect, it } from 'vitest';
import { withTestDatabase } from '../helpers/db';
import { makeLead } from '../helpers/factories';
import { resetEnvCache } from '@/lib/env';
import { enqueue, getJob, listJobs } from '@/worker/queue';
import { runOnce } from '@/worker/runtime';
import { SimulatedBrowserDriver } from '@/integrations/browser/simulated-driver';
import { incrementDmCounter } from '@/features/campaigns/guardrails';
import { getLead } from '@/features/leads/repository';

/**
 * The dispatcher is what makes outreach scale without manufacturing dead leads.
 * Qualification used to enqueue a send per qualified lead, which cannot respect
 * a daily cap: everything above it woke to a pacing refusal, burned its
 * attempts and dead-lettered. Here delivery pulls instead, one lead at a time.
 */

withTestDatabase();

/** 2026-08-30 13:00 UTC is 10:00 in America/Belem, inside operating hours. */
const insideHours = new Date('2026-08-30T13:00:00Z');
const outsideHours = new Date('2026-08-30T04:00:00Z');

beforeEach(() => {
  process.env.CHROME_CDP_URL = 'http://127.0.0.1:9222';
  process.env.OPERATING_HOURS = '09:00-20:00';
  process.env.OPERATING_TIMEZONE = 'America/Belem';
  process.env.MAX_DMS_PER_DAY = '30';
  process.env.MIN_SECONDS_BETWEEN_DMS = '90';
  process.env.MAX_SECONDS_BETWEEN_DMS = '240';
  resetEnvCache();
});

async function tick(now: Date): Promise<string | undefined> {
  enqueue({ type: 'dispatch_outreach', scheduledAt: now });
  const result = await runOnce({
    dmDriver: new SimulatedBrowserDriver(),
    types: ['dispatch_outreach'],
    now: () => now,
  });
  return result.detail;
}

describe('outreach dispatcher', () => {
  it('releases exactly one send for the best qualified lead', async () => {
    makeLead({ handle: 'lead_menor', bio: 'Distribuidora pequena.' });
    const strong = makeLead({ handle: 'lead_maior' });

    await tick(insideHours);

    const queued = listJobs({ types: ['send_first_dm'] });
    expect(queued).toHaveLength(1);
    // Ordering is by priority then ICP score, so the backlog is worked best
    // first rather than oldest first.
    expect(queued[0]?.leadId).toBe(strong.id);
  });

  it('does not queue a second send while one is still in flight', async () => {
    makeLead();
    makeLead();

    await tick(insideHours);
    await tick(insideHours);

    expect(listJobs({ types: ['send_first_dm'] })).toHaveLength(1);
  });

  it('releases nothing once the daily cap is reached', async () => {
    makeLead();
    // The warm-up cap is 5/day in week one.
    for (let index = 0; index < 5; index += 1) incrementDmCounter(insideHours);

    const detail = await tick(insideHours);

    expect(listJobs({ types: ['send_first_dm'] })).toHaveLength(0);
    expect(detail).toContain('Sem vaga de envio');
  });

  it('releases nothing outside operating hours', async () => {
    makeLead();

    await tick(outsideHours);

    expect(listJobs({ types: ['send_first_dm'] })).toHaveLength(0);
  });

  it('ignores leads that are not waiting for a first contact', async () => {
    const lead = makeLead({ qualify: false });
    expect(getLead(lead.id).pipelineStage).toBe('discovered');

    const detail = await tick(insideHours);

    expect(listJobs({ types: ['send_first_dm'] })).toHaveLength(0);
    expect(detail).toContain('Nenhum lead qualificado');
  });

  it('finishes its tick even when browser outreach is switched off', async () => {
    makeLead();
    process.env.CHROME_CDP_URL = '';
    resetEnvCache();

    // The dispatcher is a scheduler, not a browser action. If the runtime
    // parked it on the capability, the deferral would hand its attempt back and
    // the tick would never finish - while a fresh one is enqueued every couple
    // of minutes, piling up immortal pending jobs for as long as the pause
    // lasts.
    for (let index = 0; index < 3; index += 1) {
      enqueue({ type: 'dispatch_outreach', scheduledAt: insideHours, maxAttempts: 1, idempotencyKey: `tick-${index}` });
      await runOnce({
        dmDriver: new SimulatedBrowserDriver(),
        types: ['dispatch_outreach'],
        now: () => insideHours,
      });
    }

    expect(listJobs({ types: ['dispatch_outreach'], statuses: ['pending'] })).toHaveLength(0);
    expect(listJobs({ types: ['dispatch_outreach'], statuses: ['succeeded'] })).toHaveLength(3);
    expect(listJobs({ types: ['send_first_dm'] })).toHaveLength(0);
  });

  it('waiting for the pacing interval does not cost the send an attempt', async () => {
    const lead = makeLead();
    // A send that is refused for pacing was never attempted. Counting it as a
    // try is what let four consecutive waits dead-letter a lead that had not
    // been contacted once.
    const { job } = enqueue({
      type: 'send_first_dm',
      payload: { leadId: lead.id },
      leadId: lead.id,
      scheduledAt: outsideHours,
    });

    const result = await runOnce({
      dmDriver: new SimulatedBrowserDriver(),
      types: ['send_first_dm'],
      now: () => outsideHours,
    });

    expect(result.status).toBe('skipped');
    const deferred = getJob(job.id);
    expect(deferred.status).toBe('pending');
    expect(deferred.attempts).toBe(0);
    expect(new Date(deferred.scheduledAt).getTime()).toBeGreaterThan(outsideHours.getTime());
  });
});
