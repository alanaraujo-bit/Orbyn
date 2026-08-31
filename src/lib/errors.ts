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
  /**
   * "Not yet", as opposed to "it failed". Pacing, operating hours and an
   * unavailable capability all mean the job was never really attempted, so the
   * queue reschedules it without spending one of its attempts. Without the
   * distinction, waiting for your turn is indistinguishable from failing, and a
   * lead that keeps landing on the minimum-interval boundary dies after four
   * waits - having never been contacted once.
   */
  readonly deferral: boolean;

  constructor(
    code: ErrorCode,
    message: string,
    options: { details?: Record<string, unknown>; retryable?: boolean; deferral?: boolean; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.details = options.details ?? {};
    this.deferral = options.deferral ?? false;
    // A deferral is retryable by definition: the work still has to happen.
    this.retryable = options.retryable ?? this.deferral;
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
