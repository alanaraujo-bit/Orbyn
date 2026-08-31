import { createHmac } from 'node:crypto';
import { describe, expect, it, beforeEach } from 'vitest';
import { withTestDatabase } from '../helpers/db';
import { resetEnvCache } from '@/lib/env';
import {
  extractInboundMessages,
  storeWebhookEvent,
  verifySignature,
  verifySubscription,
  webhookPayloadSchema,
} from '@/integrations/instagram/webhook';

withTestDatabase();

const APP_SECRET = 'segredo-de-teste';

beforeEach(() => {
  process.env.INSTAGRAM_APP_SECRET = APP_SECRET;
  process.env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN = 'token-de-verificacao';
  resetEnvCache();
});

function sign(body: string): string {
  return `sha256=${createHmac('sha256', APP_SECRET).update(body, 'utf8').digest('hex')}`;
}

const payload = {
  object: 'instagram',
  entry: [
    {
      id: 'business_1',
      time: 1_780_000_000_000,
      messaging: [
        {
          sender: { id: 'user_1' },
          recipient: { id: 'business_1' },
          timestamp: 1_780_000_000_000,
          message: { mid: 'mid_abc', text: 'Oi, tudo bem?' },
        },
        {
          sender: { id: 'business_1' },
          recipient: { id: 'user_1' },
          message: { mid: 'mid_echo', text: 'nossa própria mensagem', is_echo: true },
        },
      ],
    },
  ],
};

describe('webhook signature', () => {
  it('accepts a correctly signed body', () => {
    const body = JSON.stringify(payload);
    expect(verifySignature(body, sign(body), APP_SECRET)).toEqual({ valid: true });
  });

  it('rejects a tampered body, a wrong secret and a missing header', () => {
    const body = JSON.stringify(payload);
    expect(verifySignature(`${body} `, sign(body), APP_SECRET).valid).toBe(false);
    expect(verifySignature(body, sign(body), 'outro-segredo').valid).toBe(false);
    expect(verifySignature(body, null, APP_SECRET).valid).toBe(false);
    expect(verifySignature(body, 'sha1=abc', APP_SECRET).valid).toBe(false);
    expect(verifySignature(body, sign(body), undefined).valid).toBe(false);
  });
});

describe('subscription handshake', () => {
  it('echoes the challenge only for the configured token', () => {
    const ok = verifySubscription(
      new URLSearchParams({ 'hub.mode': 'subscribe', 'hub.verify_token': 'token-de-verificacao', 'hub.challenge': '12345' }),
    );
    expect(ok).toEqual({ ok: true, challenge: '12345' });

    const bad = verifySubscription(
      new URLSearchParams({ 'hub.mode': 'subscribe', 'hub.verify_token': 'errado', 'hub.challenge': '12345' }),
    );
    expect(bad.ok).toBe(false);
  });
});

describe('payload handling', () => {
  it('keeps only real inbound text messages', () => {
    const parsed = webhookPayloadSchema.parse(payload);
    const messages = extractInboundMessages(parsed);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.externalId).toBe('mid_abc');
    expect(messages[0]?.senderId).toBe('user_1');
  });

  it('rejects a payload that does not match the schema', () => {
    expect(webhookPayloadSchema.safeParse({ object: 'instagram' }).success).toBe(false);
  });

  it('stores each delivery once, however many times Meta retries', () => {
    const parsed = webhookPayloadSchema.parse(payload);
    const event = extractInboundMessages(parsed)[0];
    if (!event) throw new Error('unreachable');

    const first = storeWebhookEvent(event, JSON.stringify(payload));
    const second = storeWebhookEvent(event, JSON.stringify(payload));

    expect(first.status).toBe('stored');
    expect(second).toEqual({ status: 'duplicate', id: first.id });
  });
});

/**
 * Envelope shapes, captured from Meta's own "Enviar para servidor" test on
 * 2026-08-30. Reading only `messaging` silently dropped every real message.
 */
describe('envelope shapes', () => {
  const CHANGES_PAYLOAD = {
    object: 'instagram',
    entry: [
      {
        id: '0',
        time: 1788121618,
        changes: [
          {
            field: 'messages',
            value: {
              sender: { id: '12334' },
              recipient: { id: '23245' },
              timestamp: '1527459824',
              message: { mid: 'random_mid', text: 'random_text' },
            },
          },
        ],
      },
    ],
  };

  it('accepts the changes envelope Meta actually sends', () => {
    const parsed = webhookPayloadSchema.safeParse(CHANGES_PAYLOAD);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const messages = extractInboundMessages(parsed.data);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.externalId).toBe('random_mid');
    expect(messages[0]?.senderId).toBe('12334');
    expect(messages[0]?.text).toBe('random_text');
  });

  it('normalises a seconds timestamp into a sane date', () => {
    const parsed = webhookPayloadSchema.parse(CHANGES_PAYLOAD);
    const received = extractInboundMessages(parsed)[0]?.receivedAt ?? '';
    // 1527459824 seconds = 2018-05-27, not 1970.
    expect(received.startsWith('2018-05-27')).toBe(true);
  });

  it('still accepts the messaging envelope', () => {
    const parsed = webhookPayloadSchema.parse(payload);
    expect(extractInboundMessages(parsed)).toHaveLength(1);
  });

  it('ignores non-message fields such as comments', () => {
    const comments = {
      object: 'instagram',
      entry: [{ id: '0', changes: [{ field: 'comments', value: { sender: { id: '1' }, recipient: { id: '2' }, message: { mid: 'c1', text: 'oi' } } }] }],
    };
    const parsed = webhookPayloadSchema.parse(comments);
    expect(extractInboundMessages(parsed)).toHaveLength(0);
  });

  it('does not double-count a message present in both envelopes', () => {
    const both = {
      object: 'instagram',
      entry: [
        {
          id: '0',
          messaging: [{ sender: { id: '1' }, recipient: { id: '2' }, message: { mid: 'same', text: 'oi' } }],
          changes: [{ field: 'messages', value: { sender: { id: '1' }, recipient: { id: '2' }, message: { mid: 'same', text: 'oi' } } }],
        },
      ],
    };
    const parsed = webhookPayloadSchema.parse(both);
    expect(extractInboundMessages(parsed)).toHaveLength(1);
  });
});

/**
 * Mixed batches, from the live incident of 2026-08-30: Meta delivered a read
 * receipt with no sender/recipient, the strict schema rejected the whole
 * delivery with a 400, and every retry failed the same way.
 */
describe('mixed and partial deliveries', () => {
  it('accepts a read receipt that carries no sender or recipient', () => {
    const readReceipt = {
      object: 'instagram',
      entry: [{ id: '0', time: 1788122000, messaging: [{ timestamp: 1788122000, read: { mid: 'x' } }] }],
    };
    const parsed = webhookPayloadSchema.safeParse(readReceipt);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(extractInboundMessages(parsed.data)).toHaveLength(0);
  });

  it('still extracts a real message riding alongside a receipt', () => {
    const mixed = {
      object: 'instagram',
      entry: [
        {
          id: '0',
          time: 1788122000,
          messaging: [
            { timestamp: 1788122000, read: { mid: 'seen_1' } },
            {
              sender: { id: '555' },
              recipient: { id: '999' },
              timestamp: 1788122001,
              message: { mid: 'real_1', text: 'Oi! Me manda no whatsapp' },
            },
          ],
        },
      ],
    };
    const parsed = webhookPayloadSchema.safeParse(mixed);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const messages = extractInboundMessages(parsed.data);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.externalId).toBe('real_1');
    expect(messages[0]?.senderId).toBe('555');
  });

  it('skips an echo of our own outbound message', () => {
    const echo = {
      object: 'instagram',
      entry: [
        {
          id: '0',
          messaging: [
            { sender: { id: '999' }, recipient: { id: '555' }, message: { mid: 'echo_1', text: 'nossa mensagem', is_echo: true } },
          ],
        },
      ],
    };
    const parsed = webhookPayloadSchema.parse(echo);
    expect(extractInboundMessages(parsed)).toHaveLength(0);
  });

  it('skips a reaction event with no message text', () => {
    const reaction = {
      object: 'instagram',
      entry: [{ id: '0', messaging: [{ sender: { id: '555' }, recipient: { id: '999' }, reaction: { emoji: '❤️' } }] }],
    };
    const parsed = webhookPayloadSchema.safeParse(reaction);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(extractInboundMessages(parsed.data)).toHaveLength(0);
  });
});
