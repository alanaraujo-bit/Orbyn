import { z } from 'zod';
import type { LeadRow, MessageRow } from '@/db/schema';
import { getBusinessConfig, outboundLink } from '@/config/business';
import type { BusinessConfig } from '@/config/schema';
import { isCapabilityUsable } from '@/features/system/capabilities';
import { callStructured } from '@/integrations/openai/client';
import { CLASSIFY_INSTRUCTIONS, leadContextBlock, openerInstructions, replyInstructions } from '@/integrations/openai/prompts';
import type { Funnel } from '@/features/leads/states';
import { classifyByRules, defaultActionFor, INTENTS, NEXT_ACTIONS, type Intent, type NextAction } from './intents';
import { snapshotSearchText, validateObservation, validateOutboundText, type PolicyViolation } from './message-policy';

/**
 * Commercial conversation engine.
 *
 * Every model output is structured, validated against the message policy, and
 * only then allowed to become an action. When the AI engine is unavailable the
 * system degrades to deterministic behaviour instead of inventing content:
 * openers fall back to a grounded template, replies fall back to human review.
 */

export type Generator = 'ai' | 'template' | 'rules';

export interface LeadSnapshot {
  postHashtags: string[];
  postCaptions: string[];
  isBusinessAccount: boolean | null;
}

export function parseSnapshot(lead: LeadRow): LeadSnapshot {
  try {
    const parsed = JSON.parse(lead.profileSnapshot) as Partial<LeadSnapshot>;
    return {
      postHashtags: parsed.postHashtags ?? [],
      postCaptions: parsed.postCaptions ?? [],
      isBusinessAccount: parsed.isBusinessAccount ?? null,
    };
  } catch {
    return { postHashtags: [], postCaptions: [], isBusinessAccount: null };
  }
}

const openerSchema = z.object({
  message: z.string().min(10),
  observationUsed: z.string().nullable(),
});

const openerJsonSchema = {
  type: 'object',
  properties: {
    message: { type: 'string', description: 'Mensagem de abertura em pt-BR.' },
    observationUsed: {
      type: ['string', 'null'],
      description:
        'Trecho COPIADO LITERALMENTE do perfil público observado, palavra por palavra, que justifica a personalização. Use null se não houver nada específico a citar. Paráfrases são reprovadas.',
    },
  },
  required: ['message', 'observationUsed'],
  additionalProperties: false,
} as const;

export interface OpenerInput {
  lead: LeadRow;
  variantGuidance: string;
  config?: BusinessConfig;
  jobId?: string | null;
}

export interface OpenerResult {
  message: string;
  observationUsed: string | null;
  generator: Generator;
  violations: PolicyViolation[];
}

export class MessagePolicyError extends Error {
  readonly violations: PolicyViolation[];
  constructor(violations: PolicyViolation[]) {
    super(`Mensagem reprovada: ${violations.map((violation) => violation.message).join('; ')}`);
    this.name = 'MessagePolicyError';
    this.violations = violations;
  }
}

/**
 * Deterministic opener used when the AI engine is off. It says only what the
 * verified claims allow and mentions the profile only through fields we
 * actually stored.
 */
export function templateOpener(lead: LeadRow, config: BusinessConfig): OpenerResult {
  const name = (lead.displayName ?? '').trim().split(/\s+/)[0] ?? '';
  const greeting = name.length > 1 ? `Oi, ${name}!` : 'Oi, tudo bem?';
  const observation = lead.category && lead.category.trim().length > 0 ? lead.category.trim() : null;
  const middle =
    observation !== null
      ? `Vi aqui no perfil que vocês trabalham com ${observation.toLowerCase()}.`
      : 'Cheguei no perfil de vocês agora e fiquei curioso sobre a operação.';
  const closing =
    lead.funnel === 'customer'
      ? `Sou ${config.owner.name}, da ${config.company.name} — a gente desenvolve software sob medida para empresas. Hoje a parte operacional de vocês roda em algum sistema próprio?`
      : `Sou ${config.owner.name}, da ${config.company.name}. Posso te explicar rapidinho como funciona a parceria que estamos montando?`;

  const message = `${greeting} ${middle} ${closing}`;
  const policy = validateOutboundText(message, config);
  return { message, observationUsed: observation, generator: 'template', violations: policy.violations };
}

export async function generateOpener(input: OpenerInput): Promise<OpenerResult> {
  const config = input.config ?? getBusinessConfig();
  const lead = input.lead;

  if (!isCapabilityUsable('ai_engine')) {
    const fallback = templateOpener(lead, config);
    if (fallback.violations.length > 0) throw new MessagePolicyError(fallback.violations);
    return fallback;
  }

  const snapshot = parseSnapshot(lead);
  const result = await callStructured({
    tier: 'reasoning',
    operation: 'generate_opener',
    schemaName: 'opener',
    jsonSchema: openerJsonSchema as unknown as Record<string, unknown>,
    parser: openerSchema,
    instructions: openerInstructions(config, lead.funnel as Funnel, input.variantGuidance),
    input: ['PERFIL PÚBLICO OBSERVADO:', leadContextBlock({
      handle: lead.handle,
      displayName: lead.displayName,
      bio: lead.bio,
      category: lead.category,
      location: lead.location,
      externalUrl: lead.externalUrl,
      postHashtags: snapshot.postHashtags,
      postCaptions: snapshot.postCaptions,
      niche: lead.niche,
      persona: lead.persona,
      funnel: lead.funnel as Funnel,
    })].join('\n'),
    leadId: lead.id,
    jobId: input.jobId ?? null,
    maxOutputTokens: 500,
  });

  const violations = [
    ...validateOutboundText(result.data.message, config).violations,
    ...validateObservation(result.data.observationUsed, snapshotSearchText(lead)).violations,
  ];
  if (violations.length > 0) throw new MessagePolicyError(violations);

  return {
    message: result.data.message.trim(),
    observationUsed: result.data.observationUsed,
    generator: 'ai',
    violations: [],
  };
}

/* -------------------------------------------------------------------------- */
/* Inbound interpretation                                                      */
/* -------------------------------------------------------------------------- */

const intentSchema = z.object({
  intent: z.enum(INTENTS),
  confidence: z.number().min(0).max(1),
  rationale: z.string().max(300),
});

const intentJsonSchema = {
  type: 'object',
  properties: {
    intent: { type: 'string', enum: [...INTENTS] },
    confidence: { type: 'number' },
    rationale: { type: 'string' },
  },
  required: ['intent', 'confidence', 'rationale'],
  additionalProperties: false,
} as const;

export interface IntentResult {
  intent: Intent;
  confidence: number;
  generator: Generator;
  rationale: string;
}

export async function interpretInbound(
  lead: LeadRow,
  messageText: string,
  jobId?: string | null,
): Promise<IntentResult> {
  const rule = classifyByRules(messageText);
  // Opt-out never depends on an external service.
  if (rule.intent === 'opt_out') {
    return { intent: 'opt_out', confidence: 1, generator: 'rules', rationale: `regra: "${rule.matched ?? ''}"` };
  }

  if (!isCapabilityUsable('ai_engine')) {
    return {
      intent: rule.intent ?? 'needs_human',
      confidence: rule.intent ? 0.6 : 0.2,
      generator: 'rules',
      rationale: rule.intent ? `regra: "${rule.matched ?? ''}"` : 'motor de IA indisponível',
    };
  }

  const result = await callStructured({
    tier: 'fast',
    operation: 'classify_intent',
    schemaName: 'inbound_intent',
    jsonSchema: intentJsonSchema as unknown as Record<string, unknown>,
    parser: intentSchema,
    instructions: CLASSIFY_INSTRUCTIONS,
    input: messageText,
    leadId: lead.id,
    jobId: jobId ?? null,
    maxOutputTokens: 200,
  });

  return { ...result.data, generator: 'ai' };
}

/* -------------------------------------------------------------------------- */
/* Reply planning                                                              */
/* -------------------------------------------------------------------------- */

const replySchema = z.object({
  action: z.enum(NEXT_ACTIONS),
  message: z.string().nullable(),
  reason: z.string().max(300),
});

const replyJsonSchema = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: [...NEXT_ACTIONS] },
    message: { type: ['string', 'null'] },
    reason: { type: 'string' },
  },
  required: ['action', 'message', 'reason'],
  additionalProperties: false,
} as const;

export interface ReplyPlan {
  action: NextAction;
  message: string | null;
  reason: string;
  generator: Generator;
}

export interface PlanReplyInput {
  lead: LeadRow;
  intent: Intent;
  history: MessageRow[];
  conversationId: string;
  config?: BusinessConfig;
  jobId?: string | null;
}

function transcript(history: MessageRow[]): string {
  return history
    .slice(-12)
    .map((message) => `${message.direction === 'inbound' ? 'LEAD' : 'NÓS'}: ${message.body}`)
    .join('\n');
}

export async function planReply(input: PlanReplyInput): Promise<ReplyPlan> {
  const config = input.config ?? getBusinessConfig();

  if (input.intent === 'opt_out') {
    return { action: 'close', message: null, reason: 'Pedido de parada atendido imediatamente.', generator: 'rules' };
  }

  if (!isCapabilityUsable('ai_engine')) {
    const action = defaultActionFor(input.intent);
    if (action === 'send_whatsapp') {
      const link = outboundLink('whatsapp', config);
      if (link) {
        return {
          action,
          message: `Perfeito! Consigo te explicar melhor por aqui: ${link}`,
          reason: 'Encaminhamento determinístico ao WhatsApp oficial.',
          generator: 'rules',
        };
      }
    }
    return {
      action: 'escalate_to_human',
      message: null,
      reason: 'Motor de IA indisponível; resposta encaminhada ao operador.',
      generator: 'rules',
    };
  }

  const result = await callStructured({
    tier: 'reasoning',
    operation: 'plan_reply',
    schemaName: 'reply_plan',
    jsonSchema: replyJsonSchema as unknown as Record<string, unknown>,
    parser: replySchema,
    instructions: replyInstructions(config, input.lead.funnel as Funnel, input.lead.pipelineStage),
    input: [
      `INTENÇÃO DETECTADA: ${input.intent}`,
      '',
      'HISTÓRICO DA CONVERSA:',
      transcript(input.history),
    ].join('\n'),
    leadId: input.lead.id,
    conversationId: input.conversationId,
    jobId: input.jobId ?? null,
    maxOutputTokens: 600,
  });

  const plan = result.data;
  if (plan.message !== null && plan.message.trim().length > 0) {
    const policy = validateOutboundText(plan.message, config);
    if (!policy.ok) throw new MessagePolicyError(policy.violations);
  }

  return { action: plan.action, message: plan.message, reason: plan.reason, generator: 'ai' };
}
