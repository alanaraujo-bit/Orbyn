-- Orbyn initial schema.
-- All timestamps are ISO-8601 UTC strings. All JSON columns hold compact JSON.

CREATE TABLE campaigns (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  funnel TEXT NOT NULL CHECK (funnel IN ('customer', 'affiliate')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'running', 'paused', 'archived')),
  keywords TEXT NOT NULL DEFAULT '[]',
  daily_target INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX campaigns_name_unique ON campaigns (name);

CREATE TABLE experiments (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  hypothesis TEXT NOT NULL,
  funnel TEXT NOT NULL CHECK (funnel IN ('customer', 'affiliate')),
  scope TEXT NOT NULL CHECK (scope IN ('opener', 'presentation', 'value_prop', 'cta', 'followup')),
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'running', 'paused', 'concluded')),
  primary_metric TEXT NOT NULL,
  min_sample_size INTEGER NOT NULL DEFAULT 60,
  exploration_rate REAL NOT NULL DEFAULT 0.1,
  analysis_window_days INTEGER NOT NULL DEFAULT 14,
  winner_variant_id TEXT,
  started_at TEXT,
  concluded_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX experiments_name_unique ON experiments (name);

CREATE TABLE experiment_variants (
  id TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  is_control INTEGER NOT NULL DEFAULT 0,
  weight REAL NOT NULL DEFAULT 1,
  guidance TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX experiment_variants_name_unique ON experiment_variants (experiment_id, name);

CREATE TABLE leads (
  id TEXT PRIMARY KEY,
  funnel TEXT NOT NULL CHECK (funnel IN ('customer', 'affiliate')),
  platform TEXT NOT NULL DEFAULT 'instagram',
  handle TEXT NOT NULL,
  platform_user_id TEXT,
  display_name TEXT,
  bio TEXT,
  category TEXT,
  location TEXT,
  external_url TEXT,
  followers_count INTEGER,
  profile_snapshot TEXT NOT NULL DEFAULT '{}',
  discovery_source TEXT NOT NULL DEFAULT 'manual',
  source_keyword TEXT,
  campaign_id TEXT REFERENCES campaigns(id) ON DELETE SET NULL,
  niche TEXT,
  persona TEXT NOT NULL DEFAULT 'unknown'
    CHECK (persona IN ('unknown', 'store', 'employee', 'owner', 'decision_maker')),
  icp_score REAL NOT NULL DEFAULT 0,
  score_breakdown TEXT NOT NULL DEFAULT '{}',
  priority INTEGER NOT NULL DEFAULT 0,
  -- Commercial stage (union of the customer and affiliate pipelines) and
  -- technical channel availability are deliberately separate columns.
  pipeline_stage TEXT NOT NULL DEFAULT 'discovered' CHECK (pipeline_stage IN (
    'discovered', 'qualified', 'contacted', 'replied', 'interested',
    'whatsapp_handoff', 'registered', 'active_customer',
    'joined_affiliate_group', 'active_affiliate', 'generated_customer', 'closed'
  )),
  channel_state TEXT NOT NULL DEFAULT 'browser_contact_pending' CHECK (channel_state IN (
    'browser_contact_pending', 'browser_contact_sent', 'waiting_inbound_reply',
    'api_eligible', 'api_active', 'api_window_closed', 'human_review_required',
    'do_not_contact', 'blocked', 'completed'
  )),
  channel_owner TEXT NOT NULL DEFAULT 'none' CHECK (channel_owner IN ('none', 'browser', 'api')),
  contact_window_start TEXT,
  contact_window_end TEXT,
  next_action_at TEXT,
  next_action_kind TEXT,
  contacted_at TEXT,
  replied_at TEXT,
  last_inbound_at TEXT,
  last_outbound_at TEXT,
  do_not_contact INTEGER NOT NULL DEFAULT 0,
  blocked_reason TEXT,
  retention_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX leads_platform_handle_unique ON leads (platform, handle);
CREATE UNIQUE INDEX leads_platform_user_unique ON leads (platform, platform_user_id)
  WHERE platform_user_id IS NOT NULL;
CREATE INDEX leads_pipeline_idx ON leads (funnel, pipeline_stage);
CREATE INDEX leads_next_action_idx ON leads (next_action_at);

CREATE TABLE lead_tags (
  lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (lead_id, tag)
);

CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  funnel TEXT NOT NULL CHECK (funnel IN ('customer', 'affiliate')),
  channel_owner TEXT NOT NULL DEFAULT 'none' CHECK (channel_owner IN ('none', 'browser', 'api')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'waiting_reply', 'human_review', 'closed')),
  last_message_at TEXT,
  last_inbound_at TEXT,
  api_window_expires_at TEXT,
  human_review_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX conversations_lead_unique ON conversations (lead_id);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  channel TEXT NOT NULL CHECK (channel IN ('browser', 'api', 'system')),
  body TEXT NOT NULL,
  intent TEXT,
  experiment_id TEXT REFERENCES experiments(id) ON DELETE SET NULL,
  variant_id TEXT REFERENCES experiment_variants(id) ON DELETE SET NULL,
  job_id TEXT,
  external_message_id TEXT,
  idempotency_key TEXT,
  meta TEXT NOT NULL DEFAULT '{}',
  sent_at TEXT,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX messages_idempotency_unique ON messages (idempotency_key);
CREATE UNIQUE INDEX messages_external_unique ON messages (external_message_id);
CREATE INDEX messages_conversation_idx ON messages (conversation_id, created_at);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'dead', 'canceled')),
  priority INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  scheduled_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  failed_at TEXT,
  error TEXT,
  idempotency_key TEXT,
  locked_by TEXT,
  locked_at TEXT,
  lock_expires_at TEXT,
  lead_id TEXT REFERENCES leads(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX jobs_idempotency_unique ON jobs (idempotency_key);
CREATE INDEX jobs_claim_idx ON jobs (status, scheduled_at, priority);

CREATE TABLE experiment_assignments (
  id TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
  variant_id TEXT NOT NULL REFERENCES experiment_variants(id) ON DELETE CASCADE,
  lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  assigned_at TEXT NOT NULL
);

CREATE UNIQUE INDEX experiment_assignments_unique ON experiment_assignments (experiment_id, lead_id);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  funnel TEXT,
  lead_id TEXT REFERENCES leads(id) ON DELETE CASCADE,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
  experiment_id TEXT REFERENCES experiments(id) ON DELETE SET NULL,
  variant_id TEXT REFERENCES experiment_variants(id) ON DELETE SET NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  occurred_at TEXT NOT NULL
);

CREATE INDEX events_type_idx ON events (type, occurred_at);
CREATE INDEX events_lead_idx ON events (lead_id, occurred_at);

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL CHECK (actor IN ('operator', 'worker', 'ai', 'system', 'webhook')),
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  before_state TEXT,
  after_state TEXT,
  reason TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX audit_log_created_idx ON audit_log (created_at);

CREATE TABLE ai_calls (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL DEFAULT 'openai',
  model TEXT NOT NULL,
  operation TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('succeeded', 'failed', 'blocked')),
  lead_id TEXT REFERENCES leads(id) ON DELETE SET NULL,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  job_id TEXT,
  error TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX ai_calls_created_idx ON ai_calls (created_at);

CREATE TABLE suppression_list (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL DEFAULT 'instagram',
  handle_hash TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('opt_out', 'operator_block', 'not_interested', 'complaint')),
  source TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX suppression_handle_unique ON suppression_list (platform, handle_hash);

CREATE TABLE strategy_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_by TEXT NOT NULL CHECK (updated_by IN ('operator', 'optimizer', 'system')),
  updated_at TEXT NOT NULL
);

CREATE TABLE capability_pauses (
  capability TEXT PRIMARY KEY,
  paused INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  details TEXT NOT NULL DEFAULT '{}',
  paused_by TEXT,
  paused_at TEXT,
  resumed_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE circuit_breakers (
  name TEXT PRIMARY KEY,
  state TEXT NOT NULL DEFAULT 'closed' CHECK (state IN ('closed', 'open', 'half_open')),
  failure_count INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  threshold INTEGER NOT NULL DEFAULT 5,
  cooldown_seconds INTEGER NOT NULL DEFAULT 900,
  opened_at TEXT,
  next_attempt_at TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE daily_counters (
  day TEXT NOT NULL,
  metric TEXT NOT NULL,
  value INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, metric)
);

CREATE TABLE config_fingerprints (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  seen_at TEXT NOT NULL
);

CREATE INDEX config_fingerprints_source_idx ON config_fingerprints (source, seen_at);

CREATE TABLE webhook_events (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL DEFAULT 'instagram',
  external_id TEXT NOT NULL,
  signature_valid INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'received'
    CHECK (status IN ('received', 'processed', 'ignored', 'failed')),
  payload TEXT NOT NULL,
  error TEXT,
  received_at TEXT NOT NULL,
  processed_at TEXT
);

CREATE UNIQUE INDEX webhook_events_external_unique ON webhook_events (provider, external_id);

CREATE TABLE alerts (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('exception', 'integration', 'safety', 'budget', 'data_integrity')),
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  code TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  context TEXT NOT NULL DEFAULT '{}',
  lead_id TEXT REFERENCES leads(id) ON DELETE SET NULL,
  job_id TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved')),
  dedupe_key TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- At most one *open* alert per dedupe key; history stays unconstrained.
CREATE UNIQUE INDEX alerts_open_dedupe_unique ON alerts (dedupe_key) WHERE status = 'open';
CREATE INDEX alerts_status_idx ON alerts (status, created_at);
