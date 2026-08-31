import { beforeEach, describe, expect, it } from 'vitest';
import { withTestDatabase } from '../helpers/db';
import { makeLead } from '../helpers/factories';
import { resetEnvCache } from '@/lib/env';
import { sendFirstContact } from '@/features/campaigns/first-contact';
import { SimulatedBrowserDriver } from '@/integrations/browser/simulated-driver';
import { getLead, transitionChannel } from '@/features/leads/repository';
import { breakerStatus } from '@/lib/circuit-breaker';
import { assertChannelTransition, canTransitionChannel } from '@/features/leads/states';
import { requireHumanReview } from '@/features/conversations/channel';

withTestDatabase();

beforeEach(() => {
  process.env.CHROME_CDP_URL = 'http://127.0.0.1:9222';
  process.env.OPERATING_HOURS = '00:00-23:59';
  resetEnvCache();
});

/**
 * A profile with no message button is a fact about that profile, not a fault in
 * our automation. Treating it as a transient failure spent the job's attempts
 * on a condition that could not change, and - far worse - fed the browser
 * circuit breaker, so a handful of unreachable prospects could pause outreach
 * to everyone else.
 */
describe('a profile that cannot receive DMs', () => {
  it('closes the lead instead of retrying, and leaves the breaker alone', async () => {
    const lead = makeLead({ handle: 'sem_botao_de_mensagem' });
    const driver = new SimulatedBrowserDriver();
    driver.setProfileState('sem_botao_de_mensagem', { kind: 'no_message_button' });

    const result = await sendFirstContact({
      leadId: lead.id,
      mode: 'live',
      driver,
      jobId: 'job_test_unreachable',
    });

    expect(result.status).toBe('messaging_unavailable');
    expect(getLead(lead.id).pipelineStage).toBe('closed');
    expect(breakerStatus('browser').state).toBe('closed');
    expect(driver.delivered).toHaveLength(0);
  });
});

/**
 * `human_review_required` is where the system parks what it could not handle.
 * Every automatic way out leads onward, never back to the browser queue, so
 * without an operator route the state was terminal in practice and a transient
 * failure buried the lead for good.
 */
describe('recovering a lead parked for human review', () => {
  it('refuses to send it back automatically', () => {
    expect(canTransitionChannel('human_review_required', 'browser_contact_pending', 'worker')).toBe(false);
    expect(() => assertChannelTransition('human_review_required', 'browser_contact_pending', 'system')).toThrow(
      /Transição de canal inválida/,
    );
  });

  it('lets the operator put it back in line', () => {
    const lead = makeLead();
    requireHumanReview(lead.id, 'falha de teste');
    expect(getLead(lead.id).channelState).toBe('human_review_required');

    const recovered = transitionChannel(
      { leadId: lead.id, to: 'browser_contact_pending', actor: 'operator', reason: 'revisado pelo operador' },
      undefined,
    );

    expect(recovered.channelState).toBe('browser_contact_pending');
  });
});
