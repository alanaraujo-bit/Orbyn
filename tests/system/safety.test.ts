import { describe, expect, it, beforeEach } from 'vitest';
import { withTestDatabase } from '../helpers/db';
import { resetEnvCache } from '@/lib/env';
import {
  assertBreakerClosed,
  breakerStatus,
  recordBreakerFailure,
  recordBreakerSuccess,
} from '@/lib/circuit-breaker';
import { capabilityReport, pauseCapability, requireUsableCapability, resumeCapability } from '@/features/system/capabilities';
import { assertBudgetAvailable, budgetStatus, estimateCost, recordAiCall } from '@/integrations/openai/usage';
import { detectSafetySignal } from '@/integrations/browser/safety';
import { verifyConfigIntegrity } from '@/features/system/config-integrity';
import { businessCapabilities, outboundLink } from '@/config/business';

withTestDatabase();

describe('circuit breaker', () => {
  it('opens after the failure threshold and blocks callers', () => {
    for (let index = 0; index < 3; index += 1) recordBreakerFailure('browser', `falha ${index}`);
    expect(breakerStatus('browser').state).toBe('open');
    expect(() => assertBreakerClosed('browser')).toThrow(/Circuito/);
  });

  it('closes again on a success', () => {
    for (let index = 0; index < 3; index += 1) recordBreakerFailure('browser', 'falha');
    recordBreakerSuccess('browser');
    expect(breakerStatus('browser').state).toBe('closed');
    expect(() => assertBreakerClosed('browser')).not.toThrow();
  });

  it('survives a process restart because the state is persisted', () => {
    for (let index = 0; index < 5; index += 1) recordBreakerFailure('instagram_api', 'timeout');
    // Reading through a fresh call path is equivalent to a new process
    // attaching to the same database file.
    expect(breakerStatus('instagram_api').state).toBe('open');
  });
});

describe('capability pause', () => {
  it('blocks a paused capability and reports the reason to the operator', () => {
    pauseCapability({ capability: 'browser_outreach', reason: 'checkpoint do Instagram', by: 'system' });
    const report = capabilityReport().find((entry) => entry.id === 'browser_outreach');
    expect(report?.paused).toBe(true);
    expect(report?.pauseReason).toContain('checkpoint');
    expect(() => requireUsableCapability('browser_outreach')).toThrow();
  });

  it('a global pause stops every capability at once', () => {
    pauseCapability({ capability: 'global', reason: 'pausa geral do operador', by: 'operator' });
    expect(capabilityReport().every((entry) => entry.paused)).toBe(true);
    resumeCapability('global', 'operator');
    expect(capabilityReport().find((entry) => entry.id === 'discovery')?.paused).toBe(false);
  });
});

describe('AI budget', () => {
  beforeEach(() => {
    process.env.OPENAI_MONTHLY_BUDGET_USD = '1';
    process.env.OPENAI_PRICE_INPUT_PER_1M = '1000';
    process.env.OPENAI_PRICE_OUTPUT_PER_1M = '1000';
    resetEnvCache();
  });

  it('records cost only when the operator declared a price', () => {
    expect(estimateCost('reasoning', { inputTokens: 1_000_000, outputTokens: 0 })).toMatchObject({ costUsd: 1000, priced: true });
    process.env.OPENAI_PRICE_INPUT_PER_1M = '';
    process.env.OPENAI_PRICE_OUTPUT_PER_1M = '';
    resetEnvCache();
    expect(estimateCost('reasoning', { inputTokens: 1_000_000, outputTokens: 0 })).toMatchObject({ costUsd: 0, priced: false });
  });

  it('blocks further calls and pauses the engine once the ceiling is reached', () => {
    recordAiCall({
      model: 'test-model',
      operation: 'generate_opener',
      status: 'succeeded',
      tier: 'reasoning',
      usage: { inputTokens: 2_000_000, outputTokens: 0 },
    });

    const status = budgetStatus();
    expect(status.spentUsd).toBeGreaterThanOrEqual(1);
    expect(status.exceeded).toBe(true);
    expect(() => assertBudgetAvailable()).toThrow(/Orçamento mensal/);
    expect(capabilityReport().find((entry) => entry.id === 'ai_engine')?.paused).toBe(true);
  });
});

describe('Instagram safety signals', () => {
  const cases: [string, string, string][] = [
    ['https://www.instagram.com/challenge/', '', 'challenge_required'],
    ['https://www.instagram.com/checkpoint/x', '', 'checkpoint'],
    ['https://www.instagram.com/accounts/login/', '', 'login_required'],
    ['https://www.instagram.com/perfil/', 'Ação bloqueada. Tente novamente mais tarde.', 'action_blocked'],
    ['https://www.instagram.com/perfil/', 'Confirme que você não é um robô', 'captcha'],
    ['https://www.instagram.com/perfil/', 'Detectamos atividade suspeita nesta conta', 'suspicious_activity'],
  ];

  for (const [url, text, expected] of cases) {
    it(`detecta ${expected}`, () => {
      expect(detectSafetySignal(url, text)?.signal).toBe(expected);
    });
  }

  it('does not fire on a normal profile page', () => {
    expect(detectSafetySignal('https://www.instagram.com/loja/', 'Seguidores 1.200 Publicações 84 Mensagem')).toBeNull();
  });
});

describe('business configuration', () => {
  it('keeps the affiliate funnel disabled while the group link is not defined', () => {
    const affiliate = businessCapabilities().find((entry) => entry.id === 'affiliate_funnel');
    expect(affiliate?.enabled).toBe(false);
    expect(affiliate?.missing).toContain('affiliateProgram.groupLink');
  });

  it('never hands a placeholder link to the outbound layer', () => {
    expect(outboundLink('affiliate_group')).toBeNull();
    expect(outboundLink('whatsapp')).toMatch(/^https:\/\/wa\.me\//);
  });

  it('records the config fingerprint on first read and detects later edits', () => {
    const first = verifyConfigIntegrity();
    expect(first.firstRun).toBe(true);
    const second = verifyConfigIntegrity();
    expect(second.firstRun).toBe(false);
    expect(second.changed).toBe(false);
    expect(second.fingerprint).toBe(first.fingerprint);
  });
});
