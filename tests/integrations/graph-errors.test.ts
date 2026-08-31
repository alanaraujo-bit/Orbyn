import { describe, expect, it } from 'vitest';
import { classifyGraphError } from '@/integrations/instagram/client';

/**
 * Error classification observed against the real Graph API on 2026-08-30.
 * The key invariant: a recipient-specific failure must never look like an
 * outage, or a few stale IGSIDs would trip the breaker and stop all messaging.
 */

describe('Graph API error classification', () => {
  it('treats an unknown recipient as ineligible, not an outage', () => {
    // Exactly what the live API returned for a non-existent recipient.
    const result = classifyGraphError(400, {
      message: 'Não foi possível encontrar o usuário solicitado.',
      type: 'IGApiException',
      code: 100,
      error_subcode: 2534014,
    });
    expect(result.code).toBe('api_ineligible_recipient');
    expect(result.retryable).toBe(false);
    expect(result.countsAsOutage).toBe(false);
  });

  it('treats a closed messaging window as non-retryable and not an outage', () => {
    const result = classifyGraphError(400, { code: 10, error_subcode: 2534022 });
    expect(result.code).toBe('api_window_closed');
    expect(result.retryable).toBe(false);
    expect(result.countsAsOutage).toBe(false);
  });

  it('treats throttling as retryable but not an outage', () => {
    for (const code of [4, 17, 32, 613]) {
      const result = classifyGraphError(400, { code });
      expect(result.code).toBe('rate_limit_exceeded');
      expect(result.retryable).toBe(true);
      expect(result.countsAsOutage).toBe(false);
    }
    expect(classifyGraphError(429, {}).code).toBe('rate_limit_exceeded');
  });

  it('treats a dead token as an outage that retrying cannot fix', () => {
    const result = classifyGraphError(400, { code: 190, message: 'invalid token' });
    expect(result.code).toBe('api_unavailable');
    expect(result.retryable).toBe(false);
    expect(result.countsAsOutage).toBe(true);
  });

  it('treats a 5xx as a retryable outage', () => {
    const result = classifyGraphError(503, {});
    expect(result.code).toBe('api_unavailable');
    expect(result.retryable).toBe(true);
    expect(result.countsAsOutage).toBe(true);
  });

  it('treats an unclassified 4xx as our bug, not an outage', () => {
    const result = classifyGraphError(400, { code: 12345 });
    expect(result.retryable).toBe(false);
    expect(result.countsAsOutage).toBe(false);
  });
});
