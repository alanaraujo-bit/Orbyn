import { sql } from 'drizzle-orm';
import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/**
 * Drizzle mirror of `src/db/migrations/*.sql`. The SQL files are authoritative;
 * `tests/db/schema-parity.test.ts` fails if the two ever drift.
 */

export const campaigns = sqliteTable(
  'campaigns',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    funnel: text('funnel').notNull(),
    status: text('status').notNull().default('draft'),
    keywords: text('keywords').notNull().default('[]'),
    dailyTarget: integer('daily_target').notNull().default(0),
    notes: text('notes'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [uniqueIndex('campaigns_name_unique').on(table.name)],
);

export const experiments = sqliteTable(
  'experiments',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    hypothesis: text('hypothesis').notNull(),
    funnel: text('funnel').notNull(),
    scope: text('scope').notNull(),
    status: text('status').notNull().default('draft'),
    primaryMetric: text('primary_metric').notNull(),
    minSampleSize: integer('min_sample_size').notNull().default(60),
    explorationRate: real('exploration_rate').notNull().default(0.1),
    analysisWindowDays: integer('analysis_window_days').notNull().default(14),
    winnerVariantId: text('winner_variant_id'),
    startedAt: text('started_at'),
    concludedAt: text('concluded_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [uniqueIndex('experiments_name_unique').on(table.name)],
);

export const experimentVariants = sqliteTable(
  'experiment_variants',
  {
    id: text('id').primaryKey(),
    experimentId: text('experiment_id')
      .notNull()
      .references(() => experiments.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    isControl: integer('is_control').notNull().default(0),
    weight: real('weight').notNull().default(1),
    guidance: text('guidance').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [uniqueIndex('experiment_variants_name_unique').on(table.experimentId, table.name)],
);

export const leads = sqliteTable(
  'leads',
  {
    id: text('id').primaryKey(),
    funnel: text('funnel').notNull(),
    platform: text('platform').notNull().default('instagram'),
    handle: text('handle').notNull(),
    platformUserId: text('platform_user_id'),
    displayName: text('display_name'),
    bio: text('bio'),
    category: text('category'),
    location: text('location'),
    externalUrl: text('external_url'),
    followersCount: integer('followers_count'),
    profileSnapshot: text('profile_snapshot').notNull().default('{}'),
    discoverySource: text('discovery_source').notNull().default('manual'),
    sourceKeyword: text('source_keyword'),
    campaignId: text('campaign_id').references(() => campaigns.id, { onDelete: 'set null' }),
    niche: text('niche'),
    persona: text('persona').notNull().default('unknown'),
    icpScore: real('icp_score').notNull().default(0),
    scoreBreakdown: text('score_breakdown').notNull().default('{}'),
    priority: integer('priority').notNull().default(0),
    pipelineStage: text('pipeline_stage').notNull().default('discovered'),
    channelState: text('channel_state').notNull().default('browser_contact_pending'),
    channelOwner: text('channel_owner').notNull().default('none'),
    contactWindowStart: text('contact_window_start'),
    contactWindowEnd: text('contact_window_end'),
    nextActionAt: text('next_action_at'),
    nextActionKind: text('next_action_kind'),
    contactedAt: text('contacted_at'),
    repliedAt: text('replied_at'),
    lastInboundAt: text('last_inbound_at'),
    lastOutboundAt: text('last_outbound_at'),
    doNotContact: integer('do_not_contact').notNull().default(0),
    blockedReason: text('blocked_reason'),
    retentionExpiresAt: text('retention_expires_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('leads_platform_handle_unique').on(table.platform, table.handle),
    uniqueIndex('leads_platform_user_unique')
      .on(table.platform, table.platformUserId)
      .where(sql`platform_user_id IS NOT NULL`),
    index('leads_pipeline_idx').on(table.funnel, table.pipelineStage),
    index('leads_next_action_idx').on(table.nextActionAt),
  ],
);

export const leadTags = sqliteTable(
  'lead_tags',
  {
    leadId: text('lead_id')
      .notNull()
      .references(() => leads.id, { onDelete: 'cascade' }),
    tag: text('tag').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.leadId, table.tag] })],
);

export const conversations = sqliteTable(
  'conversations',
  {
    id: text('id').primaryKey(),
    leadId: text('lead_id')
      .notNull()
      .references(() => leads.id, { onDelete: 'cascade' }),
    funnel: text('funnel').notNull(),
    channelOwner: text('channel_owner').notNull().default('none'),
    status: text('status').notNull().default('open'),
    lastMessageAt: text('last_message_at'),
    lastInboundAt: text('last_inbound_at'),
    apiWindowExpiresAt: text('api_window_expires_at'),
    humanReviewReason: text('human_review_reason'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [uniqueIndex('conversations_lead_unique').on(table.leadId)],
);

export const messages = sqliteTable(
  'messages',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    leadId: text('lead_id')
      .notNull()
      .references(() => leads.id, { onDelete: 'cascade' }),
    direction: text('direction').notNull(),
    channel: text('channel').notNull(),
    body: text('body').notNull(),
    intent: text('intent'),
    experimentId: text('experiment_id').references(() => experiments.id, { onDelete: 'set null' }),
    variantId: text('variant_id').references(() => experimentVariants.id, { onDelete: 'set null' }),
    jobId: text('job_id'),
    externalMessageId: text('external_message_id'),
    idempotencyKey: text('idempotency_key'),
    meta: text('meta').notNull().default('{}'),
    sentAt: text('sent_at'),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('messages_idempotency_unique').on(table.idempotencyKey),
    uniqueIndex('messages_external_unique').on(table.externalMessageId),
    index('messages_conversation_idx').on(table.conversationId, table.createdAt),
  ],
);

export const jobs = sqliteTable(
  'jobs',
  {
    id: text('id').primaryKey(),
    type: text('type').notNull(),
    payload: text('payload').notNull().default('{}'),
    status: text('status').notNull().default('pending'),
    priority: integer('priority').notNull().default(0),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(3),
    scheduledAt: text('scheduled_at').notNull(),
    startedAt: text('started_at'),
    completedAt: text('completed_at'),
    failedAt: text('failed_at'),
    error: text('error'),
    idempotencyKey: text('idempotency_key'),
    lockedBy: text('locked_by'),
    lockedAt: text('locked_at'),
    lockExpiresAt: text('lock_expires_at'),
    leadId: text('lead_id').references(() => leads.id, { onDelete: 'cascade' }),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('jobs_idempotency_unique').on(table.idempotencyKey),
    index('jobs_claim_idx').on(table.status, table.scheduledAt, table.priority),
  ],
);

export const experimentAssignments = sqliteTable(
  'experiment_assignments',
  {
    id: text('id').primaryKey(),
    experimentId: text('experiment_id')
      .notNull()
      .references(() => experiments.id, { onDelete: 'cascade' }),
    variantId: text('variant_id')
      .notNull()
      .references(() => experimentVariants.id, { onDelete: 'cascade' }),
    leadId: text('lead_id')
      .notNull()
      .references(() => leads.id, { onDelete: 'cascade' }),
    assignedAt: text('assigned_at').notNull(),
  },
  (table) => [uniqueIndex('experiment_assignments_unique').on(table.experimentId, table.leadId)],
);

export const events = sqliteTable(
  'events',
  {
    id: text('id').primaryKey(),
    type: text('type').notNull(),
    funnel: text('funnel'),
    leadId: text('lead_id').references(() => leads.id, { onDelete: 'cascade' }),
    conversationId: text('conversation_id').references(() => conversations.id, { onDelete: 'cascade' }),
    experimentId: text('experiment_id').references(() => experiments.id, { onDelete: 'set null' }),
    variantId: text('variant_id').references(() => experimentVariants.id, { onDelete: 'set null' }),
    payload: text('payload').notNull().default('{}'),
    occurredAt: text('occurred_at').notNull(),
  },
  (table) => [
    index('events_type_idx').on(table.type, table.occurredAt),
    index('events_lead_idx').on(table.leadId, table.occurredAt),
  ],
);

export const auditLog = sqliteTable(
  'audit_log',
  {
    id: text('id').primaryKey(),
    actor: text('actor').notNull(),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id'),
    beforeState: text('before_state'),
    afterState: text('after_state'),
    reason: text('reason'),
    createdAt: text('created_at').notNull(),
  },
  (table) => [index('audit_log_created_idx').on(table.createdAt)],
);

export const aiCalls = sqliteTable(
  'ai_calls',
  {
    id: text('id').primaryKey(),
    provider: text('provider').notNull().default('openai'),
    model: text('model').notNull(),
    operation: text('operation').notNull(),
    inputTokens: integer('input_tokens').notNull().default(0),
    /** Subset of inputTokens served from the prompt cache, billed cheaper. */
    cachedInputTokens: integer('cached_input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    costUsd: real('cost_usd').notNull().default(0),
    status: text('status').notNull(),
    leadId: text('lead_id').references(() => leads.id, { onDelete: 'set null' }),
    conversationId: text('conversation_id').references(() => conversations.id, { onDelete: 'set null' }),
    jobId: text('job_id'),
    error: text('error'),
    createdAt: text('created_at').notNull(),
  },
  (table) => [index('ai_calls_created_idx').on(table.createdAt)],
);

export const suppressionList = sqliteTable(
  'suppression_list',
  {
    id: text('id').primaryKey(),
    platform: text('platform').notNull().default('instagram'),
    handleHash: text('handle_hash').notNull(),
    reason: text('reason').notNull(),
    source: text('source').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [uniqueIndex('suppression_handle_unique').on(table.platform, table.handleHash)],
);

export const strategyState = sqliteTable('strategy_state', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedBy: text('updated_by').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const capabilityPauses = sqliteTable('capability_pauses', {
  capability: text('capability').primaryKey(),
  paused: integer('paused').notNull().default(0),
  reason: text('reason'),
  details: text('details').notNull().default('{}'),
  pausedBy: text('paused_by'),
  pausedAt: text('paused_at'),
  resumedAt: text('resumed_at'),
  updatedAt: text('updated_at').notNull(),
});

export const circuitBreakers = sqliteTable('circuit_breakers', {
  name: text('name').primaryKey(),
  state: text('state').notNull().default('closed'),
  failureCount: integer('failure_count').notNull().default(0),
  successCount: integer('success_count').notNull().default(0),
  threshold: integer('threshold').notNull().default(5),
  cooldownSeconds: integer('cooldown_seconds').notNull().default(900),
  openedAt: text('opened_at'),
  nextAttemptAt: text('next_attempt_at'),
  lastError: text('last_error'),
  updatedAt: text('updated_at').notNull(),
});

export const dailyCounters = sqliteTable(
  'daily_counters',
  {
    day: text('day').notNull(),
    metric: text('metric').notNull(),
    value: integer('value').notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.day, table.metric] })],
);

export const configFingerprints = sqliteTable(
  'config_fingerprints',
  {
    id: text('id').primaryKey(),
    source: text('source').notNull(),
    fingerprint: text('fingerprint').notNull(),
    seenAt: text('seen_at').notNull(),
  },
  (table) => [index('config_fingerprints_source_idx').on(table.source, table.seenAt)],
);

export const webhookEvents = sqliteTable(
  'webhook_events',
  {
    id: text('id').primaryKey(),
    provider: text('provider').notNull().default('instagram'),
    externalId: text('external_id').notNull(),
    signatureValid: integer('signature_valid').notNull().default(0),
    status: text('status').notNull().default('received'),
    payload: text('payload').notNull(),
    error: text('error'),
    receivedAt: text('received_at').notNull(),
    processedAt: text('processed_at'),
  },
  (table) => [uniqueIndex('webhook_events_external_unique').on(table.provider, table.externalId)],
);

export const alerts = sqliteTable(
  'alerts',
  {
    id: text('id').primaryKey(),
    kind: text('kind').notNull(),
    severity: text('severity').notNull(),
    code: text('code').notNull(),
    title: text('title').notNull(),
    detail: text('detail').notNull().default(''),
    context: text('context').notNull().default('{}'),
    leadId: text('lead_id').references(() => leads.id, { onDelete: 'set null' }),
    jobId: text('job_id'),
    status: text('status').notNull().default('open'),
    dedupeKey: text('dedupe_key'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('alerts_open_dedupe_unique').on(table.dedupeKey).where(sql`status = 'open'`),
    index('alerts_status_idx').on(table.status, table.createdAt),
  ],
);

export type LeadRow = typeof leads.$inferSelect;
export type LeadInsert = typeof leads.$inferInsert;
export type ConversationRow = typeof conversations.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type JobRow = typeof jobs.$inferSelect;
export type AlertRow = typeof alerts.$inferSelect;
export type ExperimentRow = typeof experiments.$inferSelect;
export type ExperimentVariantRow = typeof experimentVariants.$inferSelect;
export type AiCallRow = typeof aiCalls.$inferSelect;
export type EventRow = typeof events.$inferSelect;
export type AuditLogRow = typeof auditLog.$inferSelect;
export type CampaignRow = typeof campaigns.$inferSelect;
