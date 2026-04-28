CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  cron_expression TEXT,
  run_at INTEGER,
  agent TEXT NOT NULL,
  prompt TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'api',
  recipient TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at INTEGER,
  next_run_at INTEGER NOT NULL,
  last_status TEXT,
  last_error TEXT,
  last_result TEXT,
  category TEXT DEFAULT 'ops',
  run_count INTEGER NOT NULL DEFAULT 0,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  notify_channels TEXT,
  notify_thread_id TEXT,
  last_notification_signature TEXT,
  last_notified_at INTEGER,
  webhook_url TEXT,
  timeout_ms INTEGER,
  authority_profile TEXT DEFAULT 'scheduled',
  chain_to TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_scheduled_next ON scheduled_tasks(enabled, next_run_at);

CREATE TABLE IF NOT EXISTS nyx_presence_state (
  id TEXT PRIMARY KEY,
  current_tension TEXT NOT NULL,
  active_preference TEXT NOT NULL,
  blocked_loop TEXT,
  last_self_chosen_action TEXT,
  last_outbound_reason TEXT,
  last_outbound_at INTEGER,
  last_heartbeat_at INTEGER,
  heartbeat_count INTEGER NOT NULL DEFAULT 0,
  quiet_count INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
