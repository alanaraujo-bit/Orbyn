import { getEnv } from '@/lib/env';
import { AppError, isAppError } from '@/lib/errors';
import { createLogger } from '@/lib/logger';
import { assertBreakerClosed, recordBreakerFailure, recordBreakerSuccess } from '@/lib/circuit-breaker';
import { requireUsableCapability } from '@/features/system/capabilities';

const log = createLogger('instagram.api');

/**
 * Instagram Messaging API client.
 *
 * Scope note (verified against Meta's Instagram Platform documentation on
 * 2026-08-30): the API can only *reply*. "Only after an Instagram user has sent
 * your app user's Instagram professional account a message can your app send a
 * message to the Instagram user." There is deliberately no cold-outreach method
 * here, and a failure on this side is never worked around with the browser.
 */

/** Graph API version pinned on purpose; bump it deliberately, not implicitly. */
export const GRAPH_API_VERSION = 'v23.0';
const GRAPH_BASE = `https://graph.instagram.com/${GRAPH_API_VERSION}`;

export interface GraphError {
  error?: { message?: string; type?: string; code?: number; error_subcode?: number };
}


/** Graph subcodes that mean "this recipient", not "the API is down". */
const RECIPIENT_SUBCODES = new Set([2534014, 2534001, 2018001]);
/** Graph codes for an expired or revoked credential. */
const AUTH_CODES = new Set([190, 102, 463, 467]);
/** Graph codes for throttling. */
const RATE_LIMIT_CODES = new Set([4, 17, 32, 613, 80007]);

interface ClassifiedError {
  code: 'api_unavailable' | 'api_ineligible_recipient' | 'api_window_closed' | 'rate_limit_exceeded';
  retryable: boolean;
  /**
   * Whether this failure says anything about the health of the integration.
   * A bad recipient does not, so it must never trip the circuit breaker: a
   * handful of stale IGSIDs would otherwise halt all messaging.
   */
  countsAsOutage: boolean;
}

export function classifyGraphError(
  status: number,
  error: GraphError['error'] | undefined,
): ClassifiedError {
  const code = error?.code;
  const subcode = error?.error_subcode;

  if (subcode !== undefined && RECIPIENT_SUBCODES.has(subcode)) {
    return { code: 'api_ineligible_recipient', retryable: false, countsAsOutage: false };
  }
  // Outside the allowed messaging window.
  if (subcode === 2534022 || subcode === 2018278) {
    return { code: 'api_window_closed', retryable: false, countsAsOutage: false };
  }
  if (code !== undefined && RATE_LIMIT_CODES.has(code)) {
    return { code: 'rate_limit_exceeded', retryable: true, countsAsOutage: false };
  }
  if (status === 429) {
    return { code: 'rate_limit_exceeded', retryable: true, countsAsOutage: false };
  }
  if (code !== undefined && AUTH_CODES.has(code)) {
    // A dead token is an outage of the integration, and retrying will not help.
    return { code: 'api_unavailable', retryable: false, countsAsOutage: true };
  }
  if (status >= 500) {
    return { code: 'api_unavailable', retryable: true, countsAsOutage: true };
  }
  // Any other 4xx is a bad request from our side: real, but not an outage.
  return { code: 'api_unavailable', retryable: false, countsAsOutage: status < 400 };
}

async function graphRequest<T>(
  path: string,
  init: { method: 'GET' | 'POST'; body?: unknown; query?: Record<string, string> },
): Promise<T> {
  const env = getEnv();
  const token = env.INSTAGRAM_PAGE_ACCESS_TOKEN;
  if (!token) throw new AppError('api_unavailable', 'INSTAGRAM_PAGE_ACCESS_TOKEN não configurado.');

  const url = new URL(`${GRAPH_BASE}${path}`);
  for (const [key, value] of Object.entries(init.query ?? {})) url.searchParams.set(key, value);

  const response = await fetch(url, {
    method: init.method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });

  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text.length > 0 ? JSON.parse(text) : {};
  } catch {
    parsed = {};
  }

  if (!response.ok) {
    const graphError = (parsed as GraphError).error;
    const classified = classifyGraphError(response.status, graphError);
    throw new AppError(classified.code, graphError?.message ?? `Graph API respondeu ${response.status}.`, {
      details: {
        status: response.status,
        type: graphError?.type,
        code: graphError?.code,
        subcode: graphError?.error_subcode,
        countsAsOutage: classified.countsAsOutage,
      },
      retryable: classified.retryable,
    });
  }

  return parsed as T;
}

export interface SendApiMessageInput {
  recipientId: string;
  text: string;
}

export interface SendApiMessageResult {
  messageId: string;
  recipientId: string;
}

export async function sendApiMessage(input: SendApiMessageInput): Promise<SendApiMessageResult> {
  requireUsableCapability('api_messaging');
  assertBreakerClosed('instagram_api');
  try {
    const response = await graphRequest<{ message_id?: string; recipient_id?: string }>('/me/messages', {
      method: 'POST',
      body: { recipient: { id: input.recipientId }, message: { text: input.text } },
    });
    recordBreakerSuccess('instagram_api');
    return {
      messageId: response.message_id ?? `unknown_${Date.now()}`,
      recipientId: response.recipient_id ?? input.recipientId,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Only an integration-level failure counts against the breaker.
    if (!isAppError(error) || error.details.countsAsOutage !== false) {
      recordBreakerFailure('instagram_api', message);
    }
    log.error('failed to send api message', {
      error: message,
      code: isAppError(error) ? error.code : 'unknown',
    });
    throw error;
  }
}

/** Resolves the public username for an Instagram-scoped sender id. */
export async function fetchUsername(igsid: string): Promise<string | null> {
  requireUsableCapability('api_messaging');
  try {
    const response = await graphRequest<{ username?: string }>(`/${igsid}`, {
      method: 'GET',
      query: { fields: 'username' },
    });
    recordBreakerSuccess('instagram_api');
    return response.username ?? null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    recordBreakerFailure('instagram_api', message);
    log.warn('failed to resolve username', { error: message });
    return null;
  }
}
