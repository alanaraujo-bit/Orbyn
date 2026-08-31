import { describe, expect, it } from 'vitest';
import { withTestDatabase } from '../helpers/db';
import { registerDiscoveredLead, qualifyLead, applyDoNotContact, findLeadByHandle } from '@/features/leads/repository';
import { isSuppressed, suppress } from '@/features/leads/suppression';
import { normalizeHandle } from '@/features/leads/handle';

withTestDatabase();

const baseProfile = {
  handle: '@DistribuidoraExemplo',
  displayName: 'Distribuidora Exemplo',
  bio: 'Distribuidora de bebidas em Belém. Precisamos organizar a gestão empresarial.',
  category: 'Distribuidora',
  location: 'Belém, Brasil',
  funnel: 'customer' as const,
  discoverySource: 'keyword_search',
  sourceKeyword: 'gestão empresarial',
};

describe('handle normalisation', () => {
  it('accepts @, bare and URL forms as the same handle', () => {
    expect(normalizeHandle('@Loja_Teste')).toBe('loja_teste');
    expect(normalizeHandle('Loja_Teste')).toBe('loja_teste');
    expect(normalizeHandle('https://www.instagram.com/Loja_Teste/')).toBe('loja_teste');
  });

  it('rejects invalid handles', () => {
    expect(() => normalizeHandle('a b c')).toThrow();
    expect(() => normalizeHandle('')).toThrow();
  });
});

describe('lead discovery', () => {
  it('creates a lead once and deduplicates every later sighting', () => {
    const first = registerDiscoveredLead(baseProfile);
    expect(first.status).toBe('created');

    const second = registerDiscoveredLead({ ...baseProfile, handle: 'distribuidoraexemplo' });
    expect(second.status).toBe('duplicate');
    if (second.status !== 'duplicate') throw new Error('unreachable');
    if (first.status !== 'created') throw new Error('unreachable');
    expect(second.lead.id).toBe(first.lead.id);

    const third = registerDiscoveredLead({ ...baseProfile, handle: 'https://instagram.com/DistribuidoraExemplo' });
    expect(third.status).toBe('duplicate');
  });

  it('refuses to re-create a suppressed handle', () => {
    suppress({ handle: 'naocontatar', reason: 'opt_out', source: 'test' });
    const result = registerDiscoveredLead({ ...baseProfile, handle: 'naocontatar' });
    expect(result.status).toBe('suppressed');
    expect(findLeadByHandle('naocontatar')).toBeUndefined();
  });

  it('scores against the configured ICP and qualifies above the threshold', () => {
    const created = registerDiscoveredLead(baseProfile);
    if (created.status !== 'created') throw new Error('unreachable');
    const result = qualifyLead(created.lead.id);
    expect(result.score).toBeGreaterThan(0);
    expect(result.lead.pipelineStage).toBe(result.qualified ? 'qualified' : 'closed');
  });

  it('closes a profile with no ICP signal at all', () => {
    const created = registerDiscoveredLead({
      handle: 'perfil_pessoal_qualquer',
      bio: 'fotos de viagem',
      funnel: 'customer',
      discoverySource: 'manual',
    });
    if (created.status !== 'created') throw new Error('unreachable');
    const result = qualifyLead(created.lead.id);
    expect(result.qualified).toBe(false);
    expect(result.lead.pipelineStage).toBe('closed');
  });
});

describe('opt-out', () => {
  it('is immediate, terminal and suppresses future discovery', () => {
    const created = registerDiscoveredLead(baseProfile);
    if (created.status !== 'created') throw new Error('unreachable');

    const updated = applyDoNotContact({
      leadId: created.lead.id,
      reason: 'opt_out',
      source: 'inbound_message',
      actor: 'worker',
    });

    expect(updated.doNotContact).toBe(1);
    expect(updated.channelState).toBe('do_not_contact');
    expect(isSuppressed(created.lead.handle)).toBe(true);

    // The suppression check runs before the dedupe check, so an opted-out
    // handle is refused outright rather than silently re-attached.
    const rediscovery = registerDiscoveredLead(baseProfile);
    expect(rediscovery.status).toBe('suppressed');

    const fresh = registerDiscoveredLead({ ...baseProfile, handle: 'outro_handle_qualquer' });
    expect(fresh.status).toBe('created');
  });
});
