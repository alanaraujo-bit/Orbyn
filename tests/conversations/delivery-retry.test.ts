import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { withTestDatabase } from '../helpers/db';
import { makeLead } from '../helpers/factories';
import { getDb } from '@/db/client';
import { conversations, leads, messages } from '@/db/schema';
import { addHours, nowIso } from '@/lib/time';
import { ensureConversation, findConversationByLead } from '@/features/conversations/repository';
import { transitionChannel } from '@/features/leads/repository';
import { deliverApiReply, type ApiSender } from '@/features/conversations/inbound';

/**
 * The outbound row is written before the API request, so a crash between the
 * two cannot double-send. The consequence is that an existing row only proves
 * an *attempt*. These tests pin the resulting contract: an unconfirmed attempt
 * is retried, a confirmed one never is.
 */

withTestDatabase();

const SENDER_ID = '17841400000000042';

function readyLead(): { leadId: string; conversationId: string } {
  const lead = makeLead();
  const db = getDb();
  const conversation = ensureConversation(lead.id, 'customer', db);
  transitionChannel({ leadId: lead.id, to: 'browser_contact_sent', actor: 'system' }, db);
  transitionChannel({ leadId: lead.id, to: 'waiting_inbound_reply', actor: 'system', owner: 'none' }, db);
  transitionChannel({ leadId: lead.id, to: 'api_eligible', actor: 'system' }, db);
  db.update(leads).set({ platformUserId: SENDER_ID }).where(eq(leads.id, lead.id)).run();
  db.update(conversations)
    .set({ channelOwner: 'api', apiWindowExpiresAt: addHours(new Date(), 12).toISOString(), updatedAt: nowIso() })
    .where(eq(conversations.id, conversation.id))
    .run();
  return { leadId: lead.id, conversationId: conversation.id };
}

const TEXT = 'Perfeito! Consigo te explicar melhor por aqui.';

describe('API reply delivery', () => {
  it('stamps the provider message id on success', async () => {
    const { leadId, conversationId } = readyLead();
    const sender: ApiSender = async () => ({ messageId: 'mid_ok_1', recipientId: SENDER_ID });

    await deliverApiReply({ leadId, conversationId, text: TEXT, jobId: 'job_1', sender });

    const rows = getDb().select().from(messages).where(eq(messages.leadId, leadId)).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.externalMessageId).toBe('mid_ok_1');
  });

  it('retries an attempt whose delivery was never confirmed', async () => {
    const { leadId, conversationId } = readyLead();

    let calls = 0;
    const flaky: ApiSender = async () => {
      calls += 1;
      if (calls === 1) throw new Error('502 do provedor');
      return { messageId: 'mid_ok_2', recipientId: SENDER_ID };
    };

    // First attempt fails after the row was already written.
    await expect(
      deliverApiReply({ leadId, conversationId, text: TEXT, jobId: 'job_1', sender: flaky }),
    ).rejects.toThrow(/502/);

    const afterFailure = getDb().select().from(messages).where(eq(messages.leadId, leadId)).all();
    expect(afterFailure).toHaveLength(1);
    expect(afterFailure[0]?.externalMessageId).toBeNull();

    // The retry must actually send, not treat the row as a completed delivery.
    await deliverApiReply({ leadId, conversationId, text: TEXT, jobId: 'job_1', sender: flaky });

    expect(calls).toBe(2);
    const afterRetry = getDb().select().from(messages).where(eq(messages.leadId, leadId)).all();
    expect(afterRetry).toHaveLength(1);
    expect(afterRetry[0]?.externalMessageId).toBe('mid_ok_2');
  });

  it('never sends twice once delivery is confirmed', async () => {
    const { leadId, conversationId } = readyLead();
    let calls = 0;
    const sender: ApiSender = async () => {
      calls += 1;
      return { messageId: 'mid_ok_3', recipientId: SENDER_ID };
    };

    await deliverApiReply({ leadId, conversationId, text: TEXT, jobId: 'job_1', sender });
    await deliverApiReply({ leadId, conversationId, text: TEXT, jobId: 'job_1', sender });
    await deliverApiReply({ leadId, conversationId, text: TEXT, jobId: 'job_retry', sender });

    expect(calls).toBe(1);
    expect(getDb().select().from(messages).where(eq(messages.leadId, leadId)).all()).toHaveLength(1);
  });

  it('keeps the conversation usable after a failed attempt', async () => {
    const { leadId, conversationId } = readyLead();
    const failing: ApiSender = async () => {
      throw new Error('falha permanente');
    };
    await expect(
      deliverApiReply({ leadId, conversationId, text: TEXT, jobId: 'job_1', sender: failing }),
    ).rejects.toThrow();

    const conversation = findConversationByLead(leadId);
    expect(conversation?.channelOwner).toBe('api');
  });
});
