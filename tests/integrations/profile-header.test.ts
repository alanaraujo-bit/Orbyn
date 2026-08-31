import { describe, expect, it } from 'vitest';
import { parseProfileHeader } from '@/integrations/browser/profile-header';
import { validateObservation } from '@/features/conversations/message-policy';

/**
 * Fixtures reproducing the header shapes that broke the extractor, anonymised:
 * the handles and personal details are invented, the structure is what the real
 * pages looked like. The simulated browser driver returns canned profiles, so
 * the extractor is never exercised end to end - this is where it gets checked.
 *
 * Prospect data is deliberately kept out of the repository (see .gitignore),
 * which matters most for the first fixture: a business account whose owner
 * writes about their own life in the bio.
 */

/** A distributor whose owner lists a personal trade in the same bio. */
const BUSINESS_WITH_PERSONAL_BIO = [
  'conta_exemplo_1',
  'Distribuidora Exemplo 🚀',
  '52 posts',
  '457 seguidores',
  '858 seguindo',
  '🧑‍🔧 Profissão mecânico',
  '🏢 Empresa Exemplo',
  'Famí...',
  'mais',
  'Seguir',
  'Enviar mensagem',
  'Destaques',
  '❤️ viagens ❤️',
].join('\n');

/** A shop whose category sits immediately after the counters row. */
const BUILDING_SUPPLIES = [
  'conta_exemplo_2',
  'Loja Exemplo de Materiais',
  '1.494 posts',
  '8.395 seguidores',
  '101 seguindo',
  'Materiais de construção',
  'EMPRESA CRIADA EM 2003',
  'mais',
  'Rua Exemplo, 133',
  'Seguir',
  'Enviar mensagem',
  'Feira 2025',
].join('\n');

/** The header whose first short line is the Follow button. */
const SUPERMARKET = [
  'conta_exemplo_3',
  'Supermercado Exemplo 🏆',
  '432 posts',
  '22,8 mil seguidores',
  '98 seguindo',
  '🏆 | Aqui seu real vale muito',
  'Seguir',
].join('\n');

describe('profile header parsing', () => {
  it('keeps the bio free of counters, buttons and highlight names', () => {
    const { bio } = parseProfileHeader(BUSINESS_WITH_PERSONAL_BIO, {
      handle: 'conta_exemplo_1',
      displayName: 'Distribuidora Exemplo 🚀',
    });

    expect(bio).not.toBeNull();
    for (const junk of ['posts', 'seguidores', 'seguindo', 'Seguir', 'Enviar mensagem', 'Destaques', 'viagens']) {
      expect(bio).not.toContain(junk);
    }
    expect(bio).toContain('Profissão mecânico');
  });

  it('drops the handle and the display name from the bio', () => {
    const { bio } = parseProfileHeader(BUILDING_SUPPLIES, {
      handle: 'conta_exemplo_2',
      displayName: 'Loja Exemplo de Materiais',
    });

    expect(bio).not.toContain('conta_exemplo_2');
    expect(bio).not.toContain('Loja Exemplo de Materiais');
    expect(bio).toContain('EMPRESA CRIADA EM 2003');
  });

  it('never guesses a category out of the header text', () => {
    // Each of these produced a different wrong answer under the old heuristic:
    // "mais" (the truncation link), the display name, and "Seguir".
    for (const [header, context] of [
      [BUSINESS_WITH_PERSONAL_BIO, { handle: 'conta_exemplo_1', displayName: 'Distribuidora Exemplo 🚀' }],
      [BUILDING_SUPPLIES, { handle: 'conta_exemplo_2', displayName: 'Loja Exemplo de Materiais' }],
      [SUPERMARKET, { handle: 'conta_exemplo_3', displayName: 'Supermercado Exemplo 🏆' }],
    ] as const) {
      expect(parseProfileHeader(header, context).category).toBeNull();
    }
  });
});

/**
 * The failure that reached a real prospect: a distributor was told "Vi que você
 * trabalha como mecânico" because the owner's own trade was in the bio. Every
 * word of it was genuinely on the profile, which is exactly why grounding
 * against the whole snapshot was not enough.
 */
describe('the observation that reached a real prospect', () => {
  it('is refused when no field of known meaning was observed', () => {
    const result = validateObservation('Profissão mecânico', '');

    expect(result.ok).toBe(false);
    expect(result.violations[0]?.code).toBe('ungrounded_observation');
  });

  it('is refused even though the words appear in the bio', () => {
    const { bio } = parseProfileHeader(BUSINESS_WITH_PERSONAL_BIO, {
      handle: 'conta_exemplo_1',
      displayName: 'Distribuidora Exemplo 🚀',
    });
    expect(bio).toContain('Profissão mecânico');

    // The bio is not licensed text: only a category is. With no category on
    // this profile, nothing may be asserted about what they do.
    expect(validateObservation('Profissão mecânico', '').ok).toBe(false);
  });

  it('still allows an observation quoted from a known category', () => {
    expect(validateObservation('Materiais de construção', 'Materiais de construção').ok).toBe(true);
  });
});
