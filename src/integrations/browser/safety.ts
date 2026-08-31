/**
 * Account-safety detection.
 *
 * Any of these signals stops the browser capability immediately. The system
 * never solves a captcha, never bypasses a challenge, never retries a flagged
 * session and never disguises itself as something other than automation.
 */

export type SafetySignal =
  | 'challenge_required'
  | 'checkpoint'
  | 'captcha'
  | 'login_required'
  | 'action_blocked'
  | 'suspicious_activity'
  | 'rate_limited'
  | 'unknown_interface';

export interface SafetyDetection {
  signal: SafetySignal;
  evidence: string;
}

const URL_SIGNALS: { pattern: RegExp; signal: SafetySignal }[] = [
  { pattern: /\/challenge\//i, signal: 'challenge_required' },
  { pattern: /\/checkpoint\//i, signal: 'checkpoint' },
  { pattern: /\/accounts\/login/i, signal: 'login_required' },
  { pattern: /\/accounts\/suspended/i, signal: 'action_blocked' },
];

const TEXT_SIGNALS: { pattern: RegExp; signal: SafetySignal }[] = [
  { pattern: /confirme que (voc[êe]|é) (não )?é um rob[ôo]|confirm you'?re not a robot|captcha|hcaptcha|recaptcha/i, signal: 'captcha' },
  { pattern: /a[çc][ãa]o bloqueada|action blocked|tente novamente mais tarde|try again later/i, signal: 'action_blocked' },
  { pattern: /atividade suspeita|suspicious (login )?activity|unusual activity|comportamento automatizado|automated behaviou?r/i, signal: 'suspicious_activity' },
  { pattern: /suspeitamos que|we suspect|help us confirm|ajude-?nos a confirmar/i, signal: 'checkpoint' },
  { pattern: /voc[êe] atingiu o limite|you'?ve reached the limit|limite de intera[çc][õo]es/i, signal: 'rate_limited' },
  { pattern: /fa[çc]a login para continuar|entre para continuar|log in to (?:instagram|continue)/i, signal: 'login_required' },
];

export function detectSafetySignal(url: string, pageText: string): SafetyDetection | null {
  for (const entry of URL_SIGNALS) {
    if (entry.pattern.test(url)) return { signal: entry.signal, evidence: `url: ${url}` };
  }
  for (const entry of TEXT_SIGNALS) {
    const match = entry.pattern.exec(pageText);
    if (match) return { signal: entry.signal, evidence: match[0].slice(0, 160) };
  }
  return null;
}

export function isTerminalSafetySignal(signal: SafetySignal): boolean {
  return signal !== 'rate_limited';
}
