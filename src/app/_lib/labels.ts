import type { ChannelOwner, ChannelState, Funnel, Persona, PipelineStage } from '@/features/leads/states';
import type { Intent, NextAction } from '@/features/conversations/intents';
import type { RuntimeCapability } from '@/features/system/capabilities';
import type { JobType } from '@/worker/queue';

/**
 * Internal values stay in English everywhere; this file is the single place
 * where they become Portuguese for the operator.
 */

export const STAGE_LABELS: Record<PipelineStage, string> = {
  discovered: 'Descoberto',
  qualified: 'Qualificado',
  contacted: 'Abordado',
  replied: 'Respondeu',
  interested: 'Interessado',
  whatsapp_handoff: 'Encaminhado ao WhatsApp',
  registered: 'Cadastrado',
  active_customer: 'Cliente ativo',
  joined_affiliate_group: 'Entrou no grupo',
  active_affiliate: 'Afiliado ativo',
  generated_customer: 'Gerou cliente',
  closed: 'Encerrado',
};

export const CHANNEL_STATE_LABELS: Record<ChannelState, string> = {
  browser_contact_pending: 'Aguardando 1º contato',
  browser_contact_sent: '1ª DM enviada',
  waiting_inbound_reply: 'Aguardando resposta',
  api_eligible: 'Elegível pela API',
  api_active: 'API ativa',
  api_window_closed: 'Janela encerrada',
  human_review_required: 'Revisão humana',
  do_not_contact: 'Não contatar',
  blocked: 'Bloqueado',
  completed: 'Concluído',
};

export const CHANNEL_OWNER_LABELS: Record<ChannelOwner, string> = {
  none: 'Nenhum',
  browser: 'Navegador',
  api: 'API oficial',
};

export const PERSONA_LABELS: Record<Persona, string> = {
  unknown: 'Não identificado',
  store: 'Loja / empresa',
  employee: 'Funcionário',
  owner: 'Proprietário',
  decision_maker: 'Decisor',
};

export const FUNNEL_LABELS: Record<Funnel, string> = {
  customer: 'Clientes',
  affiliate: 'Afiliados',
};

export const INTENT_LABELS: Record<Intent, string> = {
  interested: 'Interessado',
  asked_info: 'Pediu informações',
  asked_pricing: 'Perguntou preço',
  wants_whatsapp: 'Quer WhatsApp',
  not_the_owner: 'Não é o responsável',
  will_forward: 'Vai encaminhar',
  objection: 'Objeção',
  not_interested: 'Sem interesse',
  opt_out: 'Pediu para parar',
  ambiguous: 'Ambíguo',
  needs_human: 'Precisa de humano',
};

export const ACTION_LABELS: Record<NextAction, string> = {
  reply: 'Responder',
  ask_question: 'Perguntar',
  introduce: 'Apresentar',
  explain: 'Explicar',
  handle_objection: 'Tratar objeção',
  send_whatsapp: 'Encaminhar ao WhatsApp',
  wait: 'Aguardar',
  schedule_followup: 'Agendar follow-up',
  close: 'Encerrar',
  escalate_to_human: 'Escalar para humano',
};

export const CAPABILITY_LABELS: Record<RuntimeCapability, string> = {
  global: 'Operação geral',
  discovery: 'Descoberta de leads',
  browser_outreach: 'Primeiro contato (navegador)',
  api_messaging: 'Mensagens pela API oficial',
  ai_engine: 'Motor de IA',
  customer_funnel: 'Funil de clientes',
  affiliate_funnel: 'Funil de afiliados',
};

export const JOB_TYPE_LABELS: Record<JobType, string> = {
  discover_leads: 'Descobrir leads',
  qualify_lead: 'Qualificar lead',
  send_first_dm: 'Enviar 1ª DM',
  process_inbound: 'Processar resposta',
  send_api_reply: 'Responder pela API',
  followup: 'Follow-up',
  expire_api_windows: 'Encerrar janelas',
  retention_cleanup: 'Retenção de dados',
  backup_database: 'Backup do banco',
  optimize_strategy: 'Otimizar estratégia',
  check_webhook_reachability: 'Verificar URL pública',
};

export const JOB_STATUS_LABELS: Record<string, string> = {
  pending: 'Na fila',
  running: 'Executando',
  succeeded: 'Concluído',
  failed: 'Falhou',
  dead: 'Esgotado',
  canceled: 'Cancelado',
};

export const ALERT_KIND_LABELS: Record<string, string> = {
  exception: 'Exceção',
  integration: 'Integração',
  safety: 'Segurança',
  budget: 'Orçamento',
  data_integrity: 'Integridade',
};

export const ALERT_SEVERITY_LABELS: Record<string, string> = {
  info: 'Informativo',
  warning: 'Atenção',
  critical: 'Crítico',
};

export const ALERT_STATUS_LABELS: Record<string, string> = {
  open: 'Aberto',
  acknowledged: 'Reconhecido',
  resolved: 'Resolvido',
};

export const ACTOR_LABELS: Record<string, string> = {
  operator: 'Operador',
  worker: 'Worker',
  ai: 'IA',
  system: 'Sistema',
  webhook: 'Webhook',
};

export const GENERATOR_LABELS: Record<string, string> = {
  ai: 'IA',
  template: 'Modelo determinístico',
  rules: 'Regras',
};

/** Human-readable explanation for a missing configuration key. */
export const MISSING_LABELS: Record<string, string> = {
  'links.whatsapp': 'Link do WhatsApp em config/business.json',
  verifiedClaims: 'Ao menos uma afirmação verificada',
  'icp.keywords': 'Palavras-chave do ICP',
  'icp.segments': 'Segmentos do ICP',
  'affiliateProgram.groupLink': 'Link do grupo de afiliados',
  'affiliateProgram.verifiedProgramClaims': 'Afirmações verificadas do programa de afiliados',
  'affiliateProgram.topics': 'Temas do programa de afiliados',
  CHROME_CDP_URL: 'CHROME_CDP_URL no .env',
  OPENAI_API_KEY: 'OPENAI_API_KEY no .env',
  INSTAGRAM_PAGE_ACCESS_TOKEN: 'INSTAGRAM_PAGE_ACCESS_TOKEN no .env',
  INSTAGRAM_BUSINESS_ACCOUNT_ID: 'INSTAGRAM_BUSINESS_ACCOUNT_ID no .env',
};

export function missingLabel(key: string): string {
  return MISSING_LABELS[key] ?? key;
}

export function labelOr(map: Record<string, string>, key: string): string {
  return map[key] ?? key;
}
