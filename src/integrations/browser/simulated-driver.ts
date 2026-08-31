import { AppError } from '@/lib/errors';
import { profileUrl } from '@/features/leads/handle';
import { detectSafetySignal } from './safety';
import type { DmDriver, SendDmCommand, SendDmResult } from './types';

/**
 * Simulated driver: a scripted stand-in for the Chrome/CDP session.
 *
 * It models the same page states the real driver has to deal with (profile
 * missing, no message button, challenge screen, success) so the whole outreach
 * pipeline - guards, ownership, idempotency, safety pause - can be exercised in
 * CI without a browser and without touching Instagram.
 */

export type SimulatedPageState =
  | { kind: 'ready' }
  | { kind: 'not_found' }
  | { kind: 'no_message_button' }
  | { kind: 'challenge'; text: string };

export interface SimulatedProfile {
  handle: string;
  state: SimulatedPageState;
}

export class SimulatedBrowserDriver implements DmDriver {
  readonly name = 'simulated-browser';

  private readonly profiles = new Map<string, SimulatedPageState>();
  private readonly defaultState: SimulatedPageState;

  /** Every DM the simulated Instagram "received". */
  readonly delivered: { handle: string; text: string; at: string }[] = [];

  constructor(profiles: SimulatedProfile[] = [], defaultState: SimulatedPageState = { kind: 'ready' }) {
    for (const profile of profiles) this.profiles.set(profile.handle.toLowerCase(), profile.state);
    this.defaultState = defaultState;
  }

  setProfileState(handle: string, state: SimulatedPageState): void {
    this.profiles.set(handle.toLowerCase(), state);
  }

  async sendDirectMessage(command: SendDmCommand): Promise<SendDmResult> {
    const state = this.profiles.get(command.handle.toLowerCase()) ?? this.defaultState;
    const url = profileUrl(command.handle);

    if (state.kind === 'not_found') {
      return { status: 'profile_not_found', evidence: { url } };
    }

    if (state.kind === 'challenge') {
      const detection = detectSafetySignal(url, state.text);
      throw new AppError('account_safety_signal', `Sinal de segurança detectado: ${detection?.signal ?? 'unknown_interface'}.`, {
        details: { signal: detection?.signal ?? 'unknown_interface', evidence: state.text.slice(0, 160) },
      });
    }

    if (state.kind === 'no_message_button') {
      return { status: 'messaging_unavailable', message: 'Botão de mensagem não encontrado no perfil.', evidence: { url } };
    }

    if (command.mode === 'dry_run') {
      return {
        status: 'dry_run_ok',
        message: 'Fluxo simulado até o campo de mensagem; envio bloqueado pelo modo dry-run.',
        evidence: { url },
      };
    }

    const at = new Date().toISOString();
    this.delivered.push({ handle: command.handle, text: command.text, at });
    return { status: 'sent', sentAt: at, evidence: { url } };
  }
}
