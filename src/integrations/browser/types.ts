/**
 * Browser channel contract.
 *
 * The engine never drives a browser directly. It emits a structured, validated
 * action and a driver executes it, so the same code path is exercised by the
 * simulated driver in tests, by a dry run and by a real send.
 */

export type DmMode = 'simulated' | 'dry_run' | 'live';

export interface SendDmCommand {
  handle: string;
  text: string;
  mode: DmMode;
  /** Correlation id used in artifacts and logs. */
  jobId: string;
}

export type DmStatus =
  | 'sent'
  | 'dry_run_ok'
  | 'profile_not_found'
  | 'messaging_unavailable'
  | 'safety_signal'
  | 'failed';

export interface DmEvidence {
  url?: string;
  screenshotPath?: string;
  accessibilitySnapshotPath?: string;
  consoleErrors?: string[];
  failedRequests?: string[];
  detectedSignal?: string;
}

export interface SendDmResult {
  status: DmStatus;
  /** Only present for a real send. */
  sentAt?: string;
  message?: string;
  evidence: DmEvidence;
}

export interface DmDriver {
  readonly name: string;
  sendDirectMessage(command: SendDmCommand): Promise<SendDmResult>;
}
