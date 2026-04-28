-- Conversations
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Messages (full history)
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  model TEXT,
  provider TEXT,
  tokens_in INTEGER DEFAULT 0,
  tokens_out INTEGER DEFAULT 0,
  cost_usd REAL DEFAULT 0,
  importance_score INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at DESC);

-- Long-term memories with FTS5 search
CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content TEXT NOT NULL,
  category TEXT,
  source TEXT,
  memory_type TEXT NOT NULL DEFAULT 'user_stated_fact',
  confidence REAL NOT NULL DEFAULT 0.6,
  source_reliability TEXT NOT NULL DEFAULT 'assistant_inferred',
  user_confirmed INTEGER NOT NULL DEFAULT 0,
  currentness TEXT NOT NULL DEFAULT 'current',
  status TEXT NOT NULL DEFAULT 'current',
  supersedes_id INTEGER,
  superseded_by_id INTEGER,
  expires_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  content, category, content=memories, content_rowid=id
);

-- Triggers to keep FTS in sync
CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content, category) VALUES (new.id, new.content, new.category);
END;

CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, category) VALUES('delete', old.id, old.content, old.category);
END;

CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, category) VALUES('delete', old.id, old.content, old.category);
  INSERT INTO memories_fts(rowid, content, category) VALUES (new.id, new.content, new.category);
END;

-- Token usage tracking (DEPRECATED — trace_events is the single source of truth)
-- Kept for backward compatibility with existing instances
CREATE TABLE IF NOT EXISTS usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  tokens_in INTEGER NOT NULL,
  tokens_out INTEGER NOT NULL,
  cost_usd REAL,
  task_type TEXT,
  timestamp INTEGER NOT NULL
);

-- Conversation summaries
CREATE TABLE IF NOT EXISTS conversation_summaries (
  conversation_id TEXT PRIMARY KEY REFERENCES conversations(id),
  summary TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS context_traces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT,
  agent_key TEXT NOT NULL,
  trace_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_context_traces_conv ON context_traces(conversation_id);
CREATE INDEX IF NOT EXISTS idx_context_traces_created ON context_traces(created_at DESC);

-- Execution traces (one per user request with actor model)
CREATE TABLE IF NOT EXISTS execution_traces (
  id TEXT PRIMARY KEY,
  origin_message_id TEXT,
  channel TEXT NOT NULL,
  sender TEXT NOT NULL,
  sender_id TEXT,
  input_message TEXT NOT NULL,
  final_response TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  total_tokens_in INTEGER DEFAULT 0,
  total_tokens_out INTEGER DEFAULT 0,
  total_cost REAL DEFAULT 0,
  total_duration_ms INTEGER DEFAULT 0,
  agent_count INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE TABLE IF NOT EXISTS trace_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trace_id TEXT NOT NULL REFERENCES execution_traces(id),
  parent_event_id INTEGER REFERENCES trace_events(id),
  agent TEXT NOT NULL,
  task TEXT NOT NULL,
  response_excerpt TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  error TEXT,
  tokens_in INTEGER DEFAULT 0,
  tokens_out INTEGER DEFAULT 0,
  cost REAL DEFAULT 0,
  duration_ms INTEGER DEFAULT 0,
  model TEXT,
  task_type TEXT,
  model_hint TEXT,
  billing_type TEXT,
  metadata_json TEXT,
  started_at INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_trace_events_trace ON trace_events(trace_id);
CREATE INDEX IF NOT EXISTS idx_trace_events_started ON trace_events(started_at);
CREATE INDEX IF NOT EXISTS idx_trace_events_model_task ON trace_events(model, task_type);
CREATE INDEX IF NOT EXISTS idx_traces_created_at ON execution_traces(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_traces_status_created ON execution_traces(status, created_at);

CREATE TABLE IF NOT EXISTS scheduled_run_artifacts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  task_name TEXT NOT NULL,
  trace_id TEXT,
  question TEXT NOT NULL,
  decision TEXT NOT NULL,
  outcome TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  artifacts_json TEXT NOT NULL,
  notified INTEGER NOT NULL DEFAULT 0,
  suppression_reason TEXT,
  notification_signature TEXT,
  model_trust_tier TEXT,
  started_at INTEGER NOT NULL,
  completed_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_scheduled_run_artifacts_completed ON scheduled_run_artifacts(completed_at DESC);
CREATE INDEX IF NOT EXISTS idx_scheduled_run_artifacts_task ON scheduled_run_artifacts(task_name, completed_at DESC);
CREATE INDEX IF NOT EXISTS idx_scheduled_run_artifacts_trace ON scheduled_run_artifacts(trace_id);

-- Agent work log (rolling memory of recent work per agent)
CREATE TABLE IF NOT EXISTS agent_work_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_key TEXT NOT NULL,
  task TEXT NOT NULL,
  result TEXT NOT NULL,
  channel TEXT,
  duration_ms INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_work_log_agent ON agent_work_log(agent_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_timestamp ON usage(timestamp DESC);

CREATE TABLE IF NOT EXISTS context_artifacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_uri TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_kind TEXT NOT NULL DEFAULT 'retrieval_artifact',
  source_label TEXT,
  import_batch_id TEXT,
  source_hash TEXT NOT NULL,
  l0_abstract TEXT,
  l1_overview TEXT,
  l0_vector BLOB,
  generated_at INTEGER,
  generation_model TEXT,
  is_stale INTEGER DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_artifacts_uri ON context_artifacts(source_uri);
CREATE INDEX IF NOT EXISTS idx_artifacts_stale ON context_artifacts(is_stale, source_type);
CREATE INDEX IF NOT EXISTS idx_artifacts_kind ON context_artifacts(source_kind, import_batch_id);

-- Messages FTS5 for global search
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  content, content=messages, content_rowid=id
);

CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.id, old.content);
END;

CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.id, old.content);
  INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
END;

-- Task outcomes (systematic agent performance tracking)
CREATE TABLE IF NOT EXISTS task_outcomes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  proposal_id TEXT,
  trace_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  task_type TEXT NOT NULL,
  review_verdict TEXT,
  retry_count INTEGER DEFAULT 0,
  pr_url TEXT,
  pr_merged INTEGER DEFAULT 0,
  time_to_merge_hours REAL,
  review_comments_count INTEGER DEFAULT 0,
  files_changed INTEGER DEFAULT 0,
  lines_added INTEGER DEFAULT 0,
  lines_removed INTEGER DEFAULT 0,
  cost_cents REAL,
  duration_ms INTEGER,
  outcome TEXT NOT NULL,
  failure_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_outcomes_agent ON task_outcomes(agent);
CREATE INDEX IF NOT EXISTS idx_outcomes_outcome ON task_outcomes(outcome);
CREATE INDEX IF NOT EXISTS idx_outcomes_created ON task_outcomes(created_at);

-- Schema version tracking (for future migrations)
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER NOT NULL,
  applied_at INTEGER NOT NULL
);
