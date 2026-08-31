/**
 * Typed application errors. Every thrown error carries a stable machine code so
 * the worker, the audit log and the panel can react without string matching.
 */

export const ERROR_CODES = [
  'config_invalid',
  'config_tampered',
  'env_invalid',
  'capability_disabled',
  'browser_unavailable',
  'browser_action_failed',
  'account_safety_signal',
  'channel_ownership_conflict',
  'duplicate_send_blocked',
  'rate_limit_exceeded',
  'outside_operating_hours',
  'suppressed_contact',
  'api_ineligible_recipient',
  'api_window_closed',
  'api_unavailable',
  'webhook_signature_invalid',
  'ai_unavailable',
  'ai_budget_exceeded',
  'ai_unsafe_output',
  'circuit_open',
  'not_found',
  'invalid_state_transition',
  'validation_failed',
  'system_paused',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown>;
  readonly retryable: boolean;

  constructor(
    code: ErrorCode,
    message: string,
    options: { details?: Record<string, unknown>; retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.details = options.details ?? {};
    this.retryable = options.retryable ?? false;
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

export function toErrorPayload(error: unknown): { code: string; message: string; details?: Record<string, unknown> } {
  if (isAppError(error)) {
    return { code: error.code, message: error.message, details: error.details };
  }
  if (error instanceof Error) {
    return { code: 'unexpected_error', message: error.message };
  }
  return { code: 'unexpected_error', message: String(error) };
}
