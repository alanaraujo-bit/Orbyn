import { describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { withTestDatabase } from '../helpers/db';
import { makeLead } from '../helpers/factories';
import { getDb } from '@/db/client';
import { leads, messages } from '@/db/schema';
import { getLead } from '@/features/leads/repository';
import { findConversationByLead, listMessages } from '@/features/conversations/repository';
import { evaluateSendGuard, expireApiWindow, IG_MESSAGING_WINDOW_HOURS } from '@/features/conversations/channel';
import { processInboundMessage, type ApiSender } from '@/features/conversations/inbound';
import { sendFirstContact } from '@/features/campaigns/first-contact';
import { isSuppressed } from '@/features/leads/suppression';
import { enqueue, getJob } from '@/worker/queue';
import { SimulatedBrowserDriver } from '@/integrations/browser/simulated-driver';
import type { InboundMessageEvent } from '@/integrations/instagram/webhook';

withTestDatabase();

const SENDER_ID = '17841400000000001';

function fakeSender(): ApiSender & { calls: { recipientId: string; text: string }[] } {
  const calls: { recipientId: string; text: string }[] = [];
  const sender = (async (input: { recipientId: string; text: string }) => {
    calls.push(input);
    return { messageId: `mid_${calls.length}`, recipientId: input.recipientId };
  }) as ApiSender & { calls: { recipientId: string; text: string }[] };
  sender.calls = calls;
  return sender;
}

async function contactedLead(): Promise<{ leadId: string; handle: string }> {
  const lead = makeLead();
  await sendFirstContact({ leadId: lead.id, mode: 'simulated', driver: new SimulatedBrowserDriver(), jobId: 'job_c' });
  getDb().update(leads).set({ platformUserId: SENDER_ID }).where(eq(leads.id, lead.id)).run();
  return { leadId: lead.id, handle: lead.handle };
}

function inbound(text: string, mid = 'mid_inbound_1'): InboundMessageEvent {
  return {
    externalId: mid,
    senderId: SENDER_ID,
    recipientId: 'business_1',
    text,
    receivedAt: new Date().toISOString(),
  };
}

describe('browser -> webhook -> API handoff', () => {
  it('moves channel ownership to the API and opens the 24h window', async () => {
    const { leadId } = await contactedLead();
    const sender = fakeSender();

    const outcome = await processInboundMessage({ event: inbound('Oi, como funciona?'), jobId: 'job_in', sender });

    expect(outcome.status).toBe('processed');
    const lead = getLead(leadId);
    expect(lead.pipelineStage).toBe('replied');
    expect(lead.channelState).not.toBe('browser_contact_pending');

    const conversation = findConversationByLead(leadId);
    expect(conversation?.channelOwner).toBe('api');
    expect(conversation?.apiWindowExpiresAt).toBeTruthy();

    const expected = new Date(conversation?.lastInboundAt ?? '').getTime() + IG_MESSAGING_WINDOW_HOURS * 3600_000;
    expect(new Date(conversation?.apiWindowExpiresAt ?? '').getTime()).toBe(expected);
  });

  it('locks the browser out of the thread for good after the handoff', async () => {
    const { leadId } = await contactedLead();
    await processInboundMessage({ event: inbound('Oi!'), jobId: 'job_in', sender: fakeSender() });

    const lead = getLead(leadId);
    const conversation = findConversationByLead(leadId);
    if (!conversation) throw new Error('unreachable');

    expect(evaluateSendGuard({ lead, conversation, channel: 'browser' }).allowed).toBe(false);

    await expect(
      sendFirstContact({
        leadId,
        mode: 'simulated',
        driver: new SimulatedBrowserDriver(),
        jobId: 'job_retry',
        now: new Date(Date.now() + 60_000),
      }),
    ).rejects.toMatchObject({ code: 'channel_ownership_conflict' });
  });

  it('ignores a duplicate delivery of the same message id', async () => {
    const { leadId } = await contactedLead();
    const sender = fakeSender();
    const event = inbound('Quero saber mais', 'mid_same');

    const first = await processInboundMessage({ event, jobId: 'job_1', sender });
    const second = await processInboundMessage({ event, jobId: 'job_1_retry', sender });

    expect(first.status).toBe('processed');
    expect(second).toEqual({ status: 'duplicate', leadId });

    const conversation = findConversationByLead(leadId);
    const inboundMessages = listMessages(conversation?.id ?? '').filter((message) => message.direction === 'inbound');
    expect(inboundMessages).toHaveLength(1);
  });

  it('refuses to send once the 24h window has closed', async () => {
    const { leadId } = await contactedLead();
    await processInboundMessage({ event: inbound('Oi'), jobId: 'job_in', sender: fakeSender() });

    const conversation = findConversationByLead(leadId);
    if (!conversation) throw new Error('unreachable');
    expireApiWindow(conversation.id);

    const lead = getLead(leadId);
    const updated = findConversationByLead(leadId);
    if (!updated) throw new Error('unreachable');
    const guard = evaluateSendGuard({
      lead,
      conversation: updated,
      channel: 'api',
      now: new Date(Date.now() + 48 * 3600_000),
    });
    expect(guard.allowed).toBe(false);
  });

  it('reports an inbound message from someone outside the funnel instead of adopting it', async () => {
    const outcome = await processInboundMessage({
      event: { ...inbound('oi'), senderId: 'desconhecido_999' },
      jobId: 'job_unknown',
      sender: fakeSender(),
    });
    expect(outcome).toEqual({ status: 'unmatched_sender', senderId: 'desconhecido_999' });
  });
});

describe('opt-out through the inbound pipeline', () => {
  it('stops immediately, cancels pending jobs and suppresses the handle', async () => {
    const { leadId, handle } = await contactedLead();
    const queued = enqueue({ type: 'followup', payload: { leadId }, leadId });
    const sender = fakeSender();

    const outcome = await processInboundMessage({
      event: inbound('Por favor, não me mande mais mensagens.'),
      jobId: 'job_optout',
      sender,
    });

    expect(outcome).toEqual({ status: 'opted_out', leadId });
    const lead = getLead(leadId);
    expect(lead.doNotContact).toBe(1);
    expect(lead.channelState).toBe('do_not_contact');
    expect(lead.pipelineStage).toBe('closed');
    expect(isSuppressed(handle)).toBe(true);
    expect(getJob(queued.job.id).status).toBe('canceled');
    // No goodbye message, no further contact of any kind.
    expect(sender.calls).toHaveLength(0);
    expect(getDb().select().from(messages).where(eq(messages.leadId, leadId)).all().filter((m) => m.direction === 'outbound')).toHaveLength(1);
  });

  it('detects opt-out without the AI engine', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { leadId } = await contactedLead();
    const outcome = await processInboundMessage({
      event: inbound('para de mandar mensagem'),
      jobId: 'job_optout_2',
      sender: fakeSender(),
    });
    expect(outcome).toEqual({ status: 'opted_out', leadId });
    spy.mockRestore();
  });
});
