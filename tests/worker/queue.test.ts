import { describe, expect, it } from 'vitest';
import { withTestDatabase } from '../helpers/db';
import { makeLead } from '../helpers/factories';
import {
  cancelJobsForLead,
  claimNextJob,
  completeJob,
  enqueue,
  failJob,
  getJob,
  LEASE_SECONDS,
  listJobs,
  queueStats,
  releaseWorkerLeases,
} from '@/worker/queue';
import { runOnce } from '@/worker/runtime';
import { SimulatedBrowserDriver } from '@/integrations/browser/simulated-driver';
import { getLead } from '@/features/leads/repository';

withTestDatabase();

describe('durable job queue', () => {
  it('is idempotent on the idempotency key', () => {
    const first = enqueue({ type: 'qualify_lead', payload: { leadId: 'x' }, idempotencyKey: 'k1' });
    const second = enqueue({ type: 'qualify_lead', payload: { leadId: 'x' }, idempotencyKey: 'k1' });
    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.job.id).toBe(first.job.id);
  });

  it('claims a job exactly once', () => {
    enqueue({ type: 'expire_api_windows' });
    const first = claimNextJob('worker-a');
    const second = claimNextJob('worker-b');
    expect(first).toBeDefined();
    expect(second).toBeUndefined();
    expect(first?.attempts).toBe(1);
  });

  it('does not claim a job scheduled in the future', () => {
    enqueue({ type: 'expire_api_windows', scheduledAt: new Date(Date.now() + 3600_000) });
    expect(claimNextJob('worker-a')).toBeUndefined();
  });

  it('retries with backoff and dead-letters when attempts run out', () => {
    const { job } = enqueue({ type: 'expire_api_windows', maxAttempts: 2 });
    claimNextJob('worker-a');
    const afterFirst = failJob(job.id, 'boom', { retryable: true });
    expect(afterFirst.status).toBe('pending');
    expect(new Date(afterFirst.scheduledAt).getTime()).toBeGreaterThan(Date.now());

    claimNextJob('worker-a', new Date(Date.now() + 3600_000));
    const afterSecond = failJob(job.id, 'boom again', { retryable: true });
    expect(afterSecond.status).toBe('dead');
    expect(queueStats().dead).toBe(1);
  });

  it('never retries a non-retryable failure', () => {
    const { job } = enqueue({ type: 'expire_api_windows', maxAttempts: 5 });
    claimNextJob('worker-a');
    expect(failJob(job.id, 'payload inválido', { retryable: false }).status).toBe('dead');
  });

  it('reclaims a lease abandoned by a crashed worker', () => {
    enqueue({ type: 'expire_api_windows' });
    const claimed = claimNextJob('worker-crashed');
    expect(claimed).toBeDefined();

    const afterLease = new Date(Date.now() + (LEASE_SECONDS + 5) * 1000);
    const reclaimed = claimNextJob('worker-new', afterLease);
    expect(reclaimed?.id).toBe(claimed?.id);
    expect(reclaimed?.attempts).toBe(2);
  });

  it('releases the leases of a worker that shuts down cleanly', () => {
    enqueue({ type: 'expire_api_windows' });
    claimNextJob('worker-a');
    expect(releaseWorkerLeases('worker-a')).toBe(1);
    expect(claimNextJob('worker-b')).toBeDefined();
  });

  it('cancels every pending job of a lead that opted out', () => {
    const lead = makeLead();
    const a = enqueue({ type: 'followup', leadId: lead.id, payload: { leadId: lead.id } });
    const b = enqueue({ type: 'send_first_dm', leadId: lead.id, payload: { leadId: lead.id } });
    expect(cancelJobsForLead(lead.id, 'opt-out')).toBe(2);
    expect(getJob(a.job.id).status).toBe('canceled');
    expect(getJob(b.job.id).status).toBe('canceled');
    expect(claimNextJob('worker-a')).toBeUndefined();
  });

  it('marks a completed job as succeeded', () => {
    const { job } = enqueue({ type: 'expire_api_windows' });
    claimNextJob('worker-a');
    completeJob(job.id);
    expect(getJob(job.id).status).toBe('succeeded');
  });
});

describe('worker runtime', () => {
  it('qualifies a lead without scheduling the send itself', async () => {
    const lead = makeLead({ qualify: false });
    enqueue({ type: 'qualify_lead', payload: { leadId: lead.id }, leadId: lead.id });

    const result = await runOnce({ dmDriver: new SimulatedBrowserDriver(), types: ['qualify_lead'] });

    expect(result.status).toBe('succeeded');
    expect(getLead(lead.id).pipelineStage).toBe('qualified');
    // Delivery is pulled, not pushed: the lead waits for the dispatcher.
    expect(listJobs({ types: ['send_first_dm'] })).toHaveLength(0);
  });

  it('re-qualifying an already qualified lead is a no-op, not a dead job', async () => {
    const lead = makeLead({ qualify: false });
    enqueue({ type: 'qualify_lead', payload: { leadId: lead.id }, leadId: lead.id });
    await runOnce({ dmDriver: new SimulatedBrowserDriver(), types: ['qualify_lead'] });
    expect(getLead(lead.id).pipelineStage).toBe('qualified');

    // Qualification reaches a lead from more than one path. The second pass
    // used to throw qualified -> qualified, dead-letter, and strand the lead.
    const { job } = enqueue({
      type: 'qualify_lead',
      payload: { leadId: lead.id },
      leadId: lead.id,
      idempotencyKey: 'requalify-test',
    });
    const again = await runOnce({ dmDriver: new SimulatedBrowserDriver(), types: ['qualify_lead'] });

    expect(again.status).toBe('succeeded');
    expect(getJob(job.id).status).toBe('succeeded');
    expect(getLead(lead.id).pipelineStage).toBe('qualified');
  });

  it('parks a job whose capability is unavailable instead of burning attempts', async () => {
    const lead = makeLead();
    const { job } = enqueue({ type: 'send_first_dm', payload: { leadId: lead.id }, leadId: lead.id });

    const result = await runOnce({ dmDriver: new SimulatedBrowserDriver(), types: ['send_first_dm'] });

    expect(result.status).toBe('skipped');
    const parked = getJob(job.id);
    expect(parked.status).toBe('pending');
    expect(new Date(parked.scheduledAt).getTime()).toBeGreaterThan(Date.now());
    // The point of parking: waiting for a capability must not count as a try,
    // or four quiet waits would dead-letter a job that never once ran.
    expect(parked.attempts).toBe(0);
  });
});
