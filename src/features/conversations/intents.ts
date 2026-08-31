/**
 * Inbound intent taxonomy plus a deterministic classifier.
 *
 * The rule pass always runs before the model. Opt-out in particular must never
 * depend on an external service being reachable or funded.
 */

export const INTENTS = [
  'interested',
  'asked_info',
  'asked_pricing',
  'wants_whatsapp',
  'not_the_owner',
  'will_forward',
  'objection',
  'not_interested',
  'opt_out',
  'ambiguous',
  'needs_human',
] as const;

export type Intent = (typeof INTENTS)[number];

export const NEXT_ACTIONS = [
  'reply',
  'ask_question',
  'introduce',
  'explain',
  'handle_objection',
  'send_whatsapp',
  'wait',
  'schedule_followup',
  'close',
  'escalate_to_human',
] as const;

export type NextAction = (typeof NEXT_ACTIONS)[number];

function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

interface IntentRule {
  intent: Intent;
  pattern: RegExp;
}

/** Ordered: the first match wins, so opt-out outranks everything else. */
const RULES: IntentRule[] = [
  {
    intent: 'opt_out',
    pattern:
      /\b(nao me mand[ae]|nao me chame|para de mandar|pare de mandar|me tira|remover|descadastr|sair da lista|nao quero receber|nao me perturbe|spam|bloquear|denunci)/,
  },
  { intent: 'wants_whatsapp', pattern: /\b(whats|whatsapp|zap|manda no whats|chama no zap|meu numero)\b/ },
  { intent: 'asked_pricing', pattern: /\b(preco|precos|quanto custa|valor|valores|orcamento|investimento|quanto fica|tabela)\b/ },
  { intent: 'not_the_owner', pattern: /\b(nao sou (o|a) (dono|dona|responsavel|proprietari)|sou (so )?(funcionari|vendedor|atendente))\b/ },
  { intent: 'will_forward', pattern: /\b(vou (passar|encaminhar|repassar)|encaminho|falo com (o|a) (dono|responsavel|gerente))\b/ },
  { intent: 'not_interested', pattern: /\b(nao tenho interesse|nao interessa|nao precisamos|ja temos|nao obrigad|no momento nao)\b/ },
  { intent: 'objection', pattern: /\b(caro|nao confio|ja tentei|nao funciona|nao tenho tempo|nao tenho verba|sem orcamento)\b/ },
  { intent: 'asked_info', pattern: /\b(como funciona|o que voces fazem|me explica|mais informacoes|qual (e )?a proposta|quem (e|sao) voces)\b/ },
  { intent: 'interested', pattern: /\b(tenho interesse|quero saber|me interessa|vamos conversar|pode falar|bora|topo)\b/ },
];

export interface RuleClassification {
  intent: Intent | null;
  matched: string | null;
}

export function classifyByRules(text: string): RuleClassification {
  const normalized = normalize(text);
  for (const rule of RULES) {
    const match = rule.pattern.exec(normalized);
    if (match) return { intent: rule.intent, matched: match[0] };
  }
  return { intent: null, matched: null };
}

/** Opt-out is checked on its own so it can gate the whole pipeline. */
export function isOptOut(text: string): boolean {
  return classifyByRules(text).intent === 'opt_out';
}

const TERMINAL_INTENTS: ReadonlySet<Intent> = new Set(['opt_out', 'not_interested']);

export function isTerminalIntent(intent: Intent): boolean {
  return TERMINAL_INTENTS.has(intent);
}

/** Deterministic fallback mapping used when the AI engine is unavailable. */
export function defaultActionFor(intent: Intent): NextAction {
  switch (intent) {
    case 'opt_out':
      return 'close';
    case 'not_interested':
      return 'close';
    case 'wants_whatsapp':
      return 'send_whatsapp';
    case 'interested':
      return 'send_whatsapp';
    case 'asked_pricing':
      return 'escalate_to_human';
    case 'asked_info':
      return 'explain';
    case 'objection':
      return 'handle_objection';
    case 'not_the_owner':
      return 'ask_question';
    case 'will_forward':
      return 'wait';
    case 'needs_human':
      return 'escalate_to_human';
    case 'ambiguous':
      return 'ask_question';
    default:
      return 'escalate_to_human';
  }
}
