import { describe, expect, it } from 'vitest';
import { parseProfileHeader } from '@/integrations/browser/profile-header';
import { validateObservation } from '@/features/conversations/message-policy';

/**
 * Regression fixtures captured from the real profiles that produced the bad
 * message. The simulated browser driver returns canned profiles, so the
 * extractor is never exercised end to end - this is where it gets checked.
 */

/** @alyssonpaiva3 - a beverage distributor whose owner lists a personal trade. */
const DISTRIBUTOR_WITH_PERSONAL_BIO = [
  'alyssonpaiva3',
  'Distribuidora embaixador 🚀',
  '52 posts',
  '457 seguidores',
  '858 seguindo',
  '🧑‍🔧 Profissão mecânico',
  '🇧🇷 🧰 Vale SA',
  '📚 Eng:mecânico 3/10',
  'Filh...',
  'mais',
  'Seguir',
  'Enviar mensagem',
  'Destaques',
  '❤️ princesa ❤️',
].join('\n');

/** @teb.materiais.construcao - the category sits right after the counters. */
const BUILDING_SUPPLIES = [
  'teb.materiais.construcao',
  'TEB - Materiais de Construção',
  '1.494 posts',
  '8.395 seguidores',
  '101 seguindo',
  'Materiais de construção',
  'EMPRESA CRIADA EM 2003',
  'mais',
  'Avenida da Ermida, 133 IRIVO, Penafiel 4560-173',
  'Seguir',
  'Enviar mensagem',
  'Gala TEB 2025',
].join('\n');

/** @supercampeao1 - the old heuristic captured the Follow button as category. */
const SUPERMARKET = [
  'supercampeao1',
  'Supermercado Campeão 🏆',
  '432 posts',
  '22,8 mil seguidores',
  '98 seguindo',
  '🏆 | Aqui seu real vale muito',
  'Seguir',
].join('\n');

describe('profile header parsing', () => {
  it('keeps the bio free of counters, buttons and highlight names', () => {
    const { bio } = parseProfileHeader(DISTRIBUTOR_WITH_PERSONAL_BIO, {
      handle: 'alyssonpaiva3',
      displayName: 'Distribuidora embaixador 🚀',
    });

    expect(bio).not.toBeNull();
    for (const junk of ['posts', 'seguidores', 'seguindo', 'Seguir', 'Enviar mensagem', 'Destaques', 'princesa']) {
      expect(bio).not.toContain(junk);
    }
    expect(bio).toContain('Profissão mecânico');
  });

  it('drops the handle and the display name from the bio', () => {
    const { bio } = parseProfileHeader(BUILDING_SUPPLIES, {
      handle: 'teb.materiais.construcao',
      displayName: 'TEB - Materiais de Construção',
    });

    expect(bio).not.toContain('teb.materiais.construcao');
    expect(bio).not.toContain('TEB - Materiais de Construção');
    expect(bio).toContain('EMPRESA CRIADA EM 2003');
  });

  it('never guesses a category out of the header text', () => {
    // Each of these produced a different wrong answer under the old heuristic:
    // "mais" (the truncation link), the display name, and "Seguir".
    for (const [header, context] of [
      [DISTRIBUTOR_WITH_PERSONAL_BIO, { handle: 'alyssonpaiva3', displayName: 'Distribuidora embaixador 🚀' }],
      [BUILDING_SUPPLIES, { handle: 'teb.materiais.construcao', displayName: 'TEB - Materiais de Construção' }],
      [SUPERMARKET, { handle: 'supercampeao1', displayName: 'Supermercado Campeão 🏆' }],
    ] as const) {
      expect(parseProfileHeader(header, context).category).toBeNull();
    }
  });
});

/**
 * The message that reached a real prospect: "Vi que você trabalha como
 * mecânico", sent to a beverage distributor. Every word of it was genuinely in
 * the profile, which is exactly why grounding against the whole snapshot was
 * not enough.
 */
describe('the observation that reached a real prospect', () => {
  it('is refused when no field of known meaning was observed', () => {
    const result = validateObservation('Profissão mecânico', '');

    expect(result.ok).toBe(false);
    expect(result.violations[0]?.code).toBe('ungrounded_observation');
  });

  it('is refused even though the words appear in the bio', () => {
    const { bio } = parseProfileHeader(DISTRIBUTOR_WITH_PERSONAL_BIO, {
      handle: 'alyssonpaiva3',
      displayName: 'Distribuidora embaixador 🚀',
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
