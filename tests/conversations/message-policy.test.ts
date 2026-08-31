import { describe, expect, it } from 'vitest';
import { getBusinessConfig } from '@/config/business';
import {
  validateObservation,
  validateOutboundText,
  snapshotSearchText,
} from '@/features/conversations/message-policy';

const config = getBusinessConfig();

describe('verified claims', () => {
  it('accepts a message built only from verified claims and questions', () => {
    const result = validateOutboundText(
      'Oi! Sou o Alan, da Aionixdev. A gente desenvolve software sob medida para empresas. Hoje a operação de vocês roda em algum sistema próprio?',
      config,
    );
    expect(result.ok).toBe(true);
  });

  it('accepts a verified claim copied verbatim', () => {
    const claim = config.verifiedClaims[0];
    expect(claim).toBeDefined();
    expect(validateOutboundText(`Só para contextualizar: ${claim}. Faz sentido conversarmos?`, config).ok).toBe(true);
  });
});

describe('blocked claims', () => {
  const cases: { label: string; text: string; code: string }[] = [
    { label: 'percentual de resultado', text: 'A gente reduz seus custos em 40% no primeiro mês.', code: 'quantified_result' },
    { label: 'valor financeiro', text: 'Você economiza R$ 5.000 por mês com o nosso sistema.', code: 'quantified_result' },
    { label: 'superlativo', text: 'Somos líder em automação no Pará.', code: 'superlative' },
    { label: 'prova social inventada', text: 'Já atendemos mais de 50 clientes no seu segmento.', code: 'invented_social_proof' },
    { label: 'garantia', text: 'Garanto que suas vendas vão crescer.', code: 'guarantee' },
    { label: 'urgência falsa', text: 'Últimas vagas para começar esse mês!', code: 'false_urgency' },
    { label: 'relação inventada', text: 'Nós já trabalhamos juntos no ano passado, lembra?', code: 'invented_relationship' },
  ];

  for (const testCase of cases) {
    it(`bloqueia ${testCase.label}`, () => {
      const result = validateOutboundText(testCase.text, config);
      expect(result.ok).toBe(false);
      expect(result.violations.map((violation) => violation.code)).toContain(testCase.code);
    });
  }
});

describe('placeholders', () => {
  it('never lets an unresolved value reach a lead', () => {
    expect(validateOutboundText('Entre no grupo: A DEFINIR', config).ok).toBe(false);
    expect(validateOutboundText('Oi {{nome}}, tudo bem?', config).ok).toBe(false);
    expect(validateOutboundText('Oi [nome do lead], tudo bem?', config).ok).toBe(false);
    expect(validateOutboundText('Link: undefined', config).ok).toBe(false);
  });

  it('rejects empty and oversized messages', () => {
    expect(validateOutboundText('   ', config).violations[0]?.code).toBe('empty');
    expect(validateOutboundText('a'.repeat(2000), config).violations[0]?.code).toBe('too_long');
  });
});

describe('observations must be grounded in the collected profile', () => {
  const snapshot = snapshotSearchText({
    handle: 'distribuidora_norte',
    displayName: 'Distribuidora Norte',
    bio: 'Distribuidora de bebidas e água mineral em Belém.',
    category: 'Distribuidora',
    location: 'Belém, Brasil',
    externalUrl: null,
    profileSnapshot: JSON.stringify({ postHashtags: ['#bebidas'], postCaptions: ['entrega para comércios'] }),
  });

  it('allows an observation supported by the profile', () => {
    expect(validateObservation('distribuidora de bebidas', snapshot).ok).toBe(true);
    expect(validateObservation(null, snapshot).ok).toBe(true);
  });

  it('rejects an inference the profile does not support', () => {
    const result = validateObservation('vocês perdem dinheiro com controle de estoque', snapshot);
    expect(result.ok).toBe(false);
    expect(result.violations[0]?.code).toBe('ungrounded_observation');
  });
});
