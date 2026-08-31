import { AppError } from '@/lib/errors';

/**
 * Pipeline stage = commercial progress. Channel state = technical availability
 * of a delivery channel. They are never merged.
 */

export const FUNNELS = ['customer', 'affiliate'] as const;
export type Funnel = (typeof FUNNELS)[number];

export const CUSTOMER_STAGES = [
  'discovered',
  'qualified',
  'contacted',
  'replied',
  'interested',
  'whatsapp_handoff',
  'registered',
  'active_customer',
  'closed',
] as const;

export const AFFILIATE_STAGES = [
  'discovered',
  'qualified',
  'contacted',
  'replied',
  'interested',
  'joined_affiliate_group',
  'active_affiliate',
  'generated_customer',
  'closed',
] as const;

export type CustomerStage = (typeof CUSTOMER_STAGES)[number];
export type AffiliateStage = (typeof AFFILIATE_STAGES)[number];
export type PipelineStage = CustomerStage | AffiliateStage;

export const CHANNEL_STATES = [
  'browser_contact_pending',
  'browser_contact_sent',
  'waiting_inbound_reply',
  'api_eligible',
  'api_active',
  'api_window_closed',
  'human_review_required',
  'do_not_contact',
  'blocked',
  'completed',
] as const;

export type ChannelState = (typeof CHANNEL_STATES)[number];

export const CHANNEL_OWNERS = ['none', 'browser', 'api'] as const;
export type ChannelOwner = (typeof CHANNEL_OWNERS)[number];

export const PERSONAS = ['unknown', 'store', 'employee', 'owner', 'decision_maker'] as const;
export type Persona = (typeof PERSONAS)[number];

/** Terminal stages never move again without operator intervention. */
const TERMINAL_STAGES: ReadonlySet<PipelineStage> = new Set(['closed']);

const CUSTOMER_TRANSITIONS: Record<CustomerStage, readonly CustomerStage[]> = {
  discovered: ['qualified', 'closed'],
  qualified: ['contacted', 'closed'],
  contacted: ['replied', 'closed'],
  replied: ['interested', 'closed'],
  interested: ['whatsapp_handoff', 'closed'],
  whatsapp_handoff: ['registered', 'closed'],
  registered: ['active_customer', 'closed'],
  active_customer: ['closed'],
  closed: [],
};

const AFFILIATE_TRANSITIONS: Record<AffiliateStage, readonly AffiliateStage[]> = {
  discovered: ['qualified', 'closed'],
  qualified: ['contacted', 'closed'],
  contacted: ['replied', 'closed'],
  replied: ['interested', 'closed'],
  interested: ['joined_affiliate_group', 'closed'],
  joined_affiliate_group: ['active_affiliate', 'closed'],
  active_affiliate: ['generated_customer', 'closed'],
  generated_customer: ['closed'],
  closed: [],
};

const CHANNEL_TRANSITIONS: Record<ChannelState, readonly ChannelState[]> = {
  browser_contact_pending: ['browser_contact_sent', 'human_review_required', 'do_not_contact', 'blocked'],
  browser_contact_sent: ['waiting_inbound_reply', 'human_review_required', 'do_not_contact', 'blocked'],
  waiting_inbound_reply: ['api_eligible', 'human_review_required', 'do_not_contact', 'blocked', 'completed'],
  api_eligible: ['api_active', 'api_window_closed', 'human_review_required', 'do_not_contact', 'blocked'],
  api_active: ['api_window_closed', 'human_review_required', 'do_not_contact', 'blocked', 'completed'],
  api_window_closed: ['api_eligible', 'human_review_required', 'do_not_contact', 'completed'],
  human_review_required: ['api_eligible', 'api_active', 'waiting_inbound_reply', 'do_not_contact', 'completed', 'blocked'],
  do_not_contact: [],
  blocked: ['human_review_required', 'do_not_contact'],
  completed: ['do_not_contact'],
};

export function stagesForFunnel(funnel: Funnel): readonly PipelineStage[] {
  return funnel === 'customer' ? CUSTOMER_STAGES : AFFILIATE_STAGES;
}

export function isStageOfFunnel(funnel: Funnel, stage: string): stage is PipelineStage {
  return (stagesForFunnel(funnel) as readonly string[]).includes(stage);
}

export function canTransitionStage(funnel: Funnel, from: PipelineStage, to: PipelineStage): boolean {
  if (from === to) return false;
  if (TERMINAL_STAGES.has(from)) return false;
  const table = funnel === 'customer' ? CUSTOMER_TRANSITIONS : AFFILIATE_TRANSITIONS;
  const allowed = (table as Record<string, readonly string[]>)[from];
  return Array.isArray(allowed) && allowed.includes(to);
}

export function assertStageTransition(funnel: Funnel, from: PipelineStage, to: PipelineStage): void {
  if (!isStageOfFunnel(funnel, to)) {
    throw new AppError('invalid_state_transition', `Etapa "${to}" não pertence ao funil "${funnel}".`, {
      details: { funnel, from, to },
    });
  }
  if (!canTransitionStage(funnel, from, to)) {
    throw new AppError('invalid_state_transition', `Transição de etapa inválida: ${from} → ${to}.`, {
      details: { funnel, from, to },
    });
  }
}

export function canTransitionChannel(from: ChannelState, to: ChannelState): boolean {
  if (from === to) return false;
  const allowed = CHANNEL_TRANSITIONS[from];
  return allowed.includes(to);
}

export function assertChannelTransition(from: ChannelState, to: ChannelState): void {
  if (!canTransitionChannel(from, to)) {
    throw new AppError('invalid_state_transition', `Transição de canal inválida: ${from} → ${to}.`, {
      details: { from, to },
    });
  }
}

/** Channel states in which no outbound message may leave the system. */
const OUTBOUND_BLOCKED: ReadonlySet<ChannelState> = new Set([
  'do_not_contact',
  'blocked',
  'human_review_required',
  'completed',
]);

export function allowsOutbound(state: ChannelState): boolean {
  return !OUTBOUND_BLOCKED.has(state);
}

export function ownerForChannelState(state: ChannelState): ChannelOwner {
  if (state === 'browser_contact_pending' || state === 'browser_contact_sent') return 'browser';
  if (state === 'api_eligible' || state === 'api_active') return 'api';
  return 'none';
}
