import type { BusinessConfig } from '@/config/schema';
import { outboundLink } from '@/config/business';
import type { Funnel } from '@/features/leads/states';

/**
 * Prompt construction.
 *
 * Only the data a given call actually needs is included - never the whole
 * business record and never the whole database. Everything factual comes from
 * `config/business.json`; the model is told explicitly that anything else is
 * off limits.
 */

export const COMMUNICATION_RULES = [
  'Você escreve mensagens comerciais em português do Brasil, em nome da empresa descrita abaixo.',
  'Escreva como uma pessoa real escrevendo para outra pessoa: curto, direto, sem formalidade artificial e sem parecer campanha em massa.',
  'Você só pode afirmar fatos sobre a empresa que estejam na lista AFIRMAÇÕES VERIFICADAS.',
  'É proibido citar números, percentuais, ROI, economia, quantidade de clientes, cases, depoimentos, garantias ou superlativos.',
  'É proibido inventar relação prévia, indicação, urgência, prazo, desconto, preço ou condição comercial.',
  'Você pode comentar apenas informações que estejam literalmente no bloco PERFIL PÚBLICO OBSERVADO.',
  'Nunca transforme observação em diagnóstico. "Vi que vocês trabalham com X" é permitido; "vocês devem estar perdendo dinheiro com X" não é.',
  'Nunca use emojis em excesso, no máximo um, e apenas quando natural.',
  'Nunca peça dados pessoais sensíveis.',
  'Se a pessoa pedir para parar, a resposta correta é encerrar com educação.',
].join('\n');

export function businessFactsBlock(config: BusinessConfig, funnel: Funnel): string {
  const lines = [
    `EMPRESA: ${config.company.name}`,
    `RESPONSÁVEL: ${config.owner.name} (${config.owner.role})`,
    `SITE: ${config.company.website}`,
    `POSICIONAMENTO: ${config.positioning.oneLinePitch}`,
    `COMO TRABALHAMOS: ${config.positioning.howItWorks.join(' | ')}`,
    '',
    'AFIRMAÇÕES VERIFICADAS (única base factual permitida):',
    ...config.verifiedClaims.map((claim) => `- ${claim}`),
  ];

  if (funnel === 'affiliate' && config.affiliateProgram.verifiedProgramClaims.length > 0) {
    lines.push('', 'AFIRMAÇÕES VERIFICADAS DO PROGRAMA DE AFILIADOS:');
    lines.push(...config.affiliateProgram.verifiedProgramClaims.map((claim) => `- ${claim}`));
  }

  lines.push('', 'PROIBIDO AFIRMAR (sem evidência):');
  lines.push(...config.unverifiedClaims.map((claim) => `- ${claim}`));

  const whatsapp = outboundLink('whatsapp', config);
  if (whatsapp) lines.push('', `LINK DE WHATSAPP OFICIAL: ${whatsapp}`);

  return lines.join('\n');
}

export interface LeadPromptContext {
  handle: string;
  displayName: string | null;
  bio: string | null;
  category: string | null;
  location: string | null;
  externalUrl: string | null;
  postHashtags: string[];
  postCaptions: string[];
  niche: string | null;
  persona: string;
  funnel: Funnel;
}

export function leadContextBlock(lead: LeadPromptContext): string {
  const rows: string[] = [`@: ${lead.handle}`];
  if (lead.displayName) rows.push(`Nome exibido: ${lead.displayName}`);
  if (lead.bio) rows.push(`Bio: ${lead.bio}`);
  if (lead.category) rows.push(`Categoria: ${lead.category}`);
  if (lead.location) rows.push(`Localização pública: ${lead.location}`);
  if (lead.externalUrl) rows.push(`Site no perfil: ${lead.externalUrl}`);
  if (lead.postHashtags.length > 0) rows.push(`Hashtags observadas: ${lead.postHashtags.join(', ')}`);
  if (lead.postCaptions.length > 0) rows.push(`Legendas observadas: ${lead.postCaptions.join(' || ')}`);
  if (lead.niche) rows.push(`Nicho inferido: ${lead.niche}`);
  rows.push(`Tipo de interlocutor: ${lead.persona}`);
  return rows.join('\n');
}

export function openerInstructions(config: BusinessConfig, funnel: Funnel, variantGuidance: string): string {
  const goal =
    funnel === 'customer'
      ? 'Objetivo: abrir uma conversa comercial com uma empresa que pode precisar de software sob medida.'
      : 'Objetivo: abrir uma conversa com um criador de conteúdo sobre o programa de afiliados.';
  return [
    COMMUNICATION_RULES,
    '',
    goal,
    'A primeira mensagem deve ter no máximo 3 frases curtas, terminar com uma pergunta simples e não conter link.',
    'Se não houver nada verdadeiro e específico a comentar sobre o perfil, defina observationUsed como null e escreva uma abertura neutra.',
    // Only the category licenses a claim about what the business does. The bio
    // is free text written by a person about themselves: a distributor whose
    // owner listed "Profissão mecânico" got told he worked as a mechanic, and
    // every word of that observation really was in the profile. Presence of a
    // word near a business is not a fact about the business.
    'A ÚNICA fonte permitida para observationUsed é o campo "categoria" do bloco PERFIL PÚBLICO OBSERVADO. Se esse campo não estiver presente, observationUsed DEVE ser null, mesmo que a bio pareça informativa.',
    'Nunca afirme a profissão, o cargo ou a atividade de alguém a partir da bio. A bio é texto livre e frequentemente mistura vida pessoal com o negócio.',
    // The grounding check requires every content word of observationUsed to
    // appear in the licensed field. A paraphrase fails it, so the field has to
    // be a quote: saying "trecho observado" was not enough to stop the model
    // from rewriting the bio in its own words and getting the message rejected.
    'observationUsed deve ser COPIADO LITERALMENTE desse campo, palavra por palavra, sem reescrever, resumir ou traduzir. Qualquer palavra que não esteja lá reprova a mensagem inteira.',
    'A mensagem em si pode ser escrita com suas palavras; a restrição literal vale apenas para observationUsed.',
    '',
    `DIRETRIZ DA VARIANTE EM TESTE: ${variantGuidance}`,
    '',
    businessFactsBlock(config, funnel),
  ].join('\n');
}

export function replyInstructions(config: BusinessConfig, funnel: Funnel, stage: string): string {
  return [
    COMMUNICATION_RULES,
    '',
    `Etapa atual do funil: ${stage}.`,
    'Responda à última mensagem da pessoa. Uma ideia por mensagem, no máximo 4 frases.',
    'Só envie o link de WhatsApp quando a ação escolhida for send_whatsapp.',
    'Se a pergunta exigir preço, prazo, proposta ou qualquer condição comercial, escolha escalate_to_human e não invente resposta.',
    '',
    businessFactsBlock(config, funnel),
  ].join('\n');
}

export const CLASSIFY_INSTRUCTIONS = [
  'Você classifica a intenção da última mensagem recebida em uma conversa comercial no Instagram, em português do Brasil.',
  'Responda apenas com a classificação estruturada. Não escreva texto livre.',
  'Use opt_out quando a pessoa pedir para não ser mais contatada, de qualquer forma.',
  'Use needs_human quando a mensagem exigir decisão comercial, jurídica ou financeira.',
].join('\n');
