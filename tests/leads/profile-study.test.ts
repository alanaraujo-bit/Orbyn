import { beforeEach, describe, expect, it } from 'vitest';
import { withTestDatabase } from '../helpers/db';
import { makeLead, recordStudy } from '../helpers/factories';
import { resetEnvCache } from '@/lib/env';
import { isAppError } from '@/lib/errors';
import { getLead, registerDiscoveredLead } from '@/features/leads/repository';
import { storedStudy, studyEvidenceText, studyProfile } from '@/features/leads/profile-study';
import { licensedObservationText, templateOpener } from '@/features/conversations/engine';
import { getBusinessConfig } from '@/config/business';
import { enqueue, listJobs } from '@/worker/queue';
import { runOnce } from '@/worker/runtime';
import { SimulatedBrowserDriver } from '@/integrations/browser/simulated-driver';

withTestDatabase();

/** 2026-08-30 13:00 UTC is 10:00 in America/Belem, inside operating hours. */
const insideHours = new Date('2026-08-30T13:00:00Z');

beforeEach(() => {
  process.env.CHROME_CDP_URL = 'http://127.0.0.1:9222';
  process.env.OPENAI_API_KEY = '';
  process.env.OPERATING_HOURS = '09:00-20:00';
  process.env.OPERATING_TIMEZONE = 'America/Belem';
  resetEnvCache();
});

/**
 * The message that reached a real prospect: "Vi que você trabalha como
 * mecânico", sent to a beverage distributor whose owner listed his own trade in
 * the bio. Nothing may be asserted about a business from free text a person
 * wrote about themselves.
 */
describe('what may be said about a business', () => {
  it('licenses nothing from the bio alone', () => {
    // No category: Instagram published none, which is the case that produced
    // the bad message. A real category would legitimately license a claim.
    const lead = makeLead({
      handle: 'distribuidora_com_bio_pessoal',
      bio: 'Distribuidora embaixador. Profissão mecânico. Casado.',
      category: '',
      activity: null,
    });

    expect(licensedObservationText(getLead(lead.id))).toBe('');
  });

  it('licenses only what the study established', () => {
    const lead = recordStudy(makeLead({ activity: null }), 'distribuidora de bebidas');

    expect(licensedObservationText(lead)).toContain('distribuidora de bebidas');
  });

  it('keeps the offline opener from asserting an unestablished activity', () => {
    const lead = makeLead({ handle: 'sem_estudo', category: '', activity: null });

    const opener = templateOpener(getLead(lead.id), getBusinessConfig());

    expect(opener.observationUsed).toBeNull();
    expect(opener.message).not.toContain('trabalham com');
  });
});

describe('studying a profile without the AI engine', () => {
  it('accepts the category, which has a known meaning', async () => {
    const outcome = registerDiscoveredLead({
      handle: 'com_categoria',
      bio: 'Perfil de teste.',
      category: 'Materiais de construção',
      funnel: 'customer',
      discoverySource: 'test',
    });
    if (outcome.status !== 'created') throw new Error('esperava lead novo');

    const study = await studyProfile(outcome.lead);

    expect(study.activity).toBe('Materiais de construção');
  });

  it('defers instead of closing a lead it simply could not assess', async () => {
    // The engine being off is a shortage on our side, not a fact about the
    // prospect. Closing them for it would destroy a good lead.
    const outcome = registerDiscoveredLead({
      handle: 'sem_categoria',
      bio: 'Distribuidora de bebidas na região.',
      funnel: 'customer',
      discoverySource: 'test',
    });
    if (outcome.status !== 'created') throw new Error('esperava lead novo');

    await expect(studyProfile(outcome.lead)).rejects.toSatisfy(
      (error: unknown) => isAppError(error) && error.deferral,
    );
  });

  it('records the absence of evidence rather than guessing', async () => {
    const outcome = registerDiscoveredLead({
      handle: 'perfil_vazio',
      funnel: 'customer',
      discoverySource: 'test',
    });
    if (outcome.status !== 'created') throw new Error('esperava lead novo');

    const study = await studyProfile(outcome.lead);

    expect(study.activity).toBeNull();
    expect(study.reason).toContain('Nenhuma evidência');
    expect(storedStudy(getLead(outcome.lead.id))?.activity).toBeNull();
  });
});

describe('evidence gathering', () => {
  it('includes what the account itself posted, not what we inferred', () => {
    const outcome = registerDiscoveredLead({
      handle: 'com_posts',
      bio: 'Bio da conta.',
      funnel: 'customer',
      discoverySource: 'test',
      postCaptions: ['Correia dentada sincroniza o motor'],
      postHashtags: ['autopecas'],
    });
    if (outcome.status !== 'created') throw new Error('esperava lead novo');

    const evidence = studyEvidenceText(getLead(outcome.lead.id));

    expect(evidence).toContain('Bio da conta.');
    expect(evidence).toContain('Correia dentada');
    expect(evidence).toContain('autopecas');
  });
});

/**
 * The gate lives in `qualify_lead`, but the dispatcher repeats it: it is the
 * last point before a real message, and leads qualified before the study step
 * existed are still sitting in the backlog.
 */
describe('the dispatcher never writes to a stranger', () => {
  it('holds back a qualified lead that was never studied', async () => {
    makeLead({ activity: null });

    enqueue({ type: 'dispatch_outreach', scheduledAt: insideHours });
    const result = await runOnce({
      dmDriver: new SimulatedBrowserDriver(),
      types: ['dispatch_outreach'],
      now: () => insideHours,
    });

    expect(listJobs({ types: ['send_first_dm'] })).toHaveLength(0);
    expect(result.detail).toContain('aguardando estudo');
  });

  it('releases the studied lead and leaves the unstudied one waiting', async () => {
    makeLead({ handle: 'nao_estudado', activity: null });
    const known = makeLead({ handle: 'estudado', activity: 'distribuidora de bebidas' });

    enqueue({ type: 'dispatch_outreach', scheduledAt: insideHours });
    await runOnce({
      dmDriver: new SimulatedBrowserDriver(),
      types: ['dispatch_outreach'],
      now: () => insideHours,
    });

    const queued = listJobs({ types: ['send_first_dm'] });
    expect(queued).toHaveLength(1);
    expect(queued[0]?.leadId).toBe(known.id);
  });
});
