-- Knowledge graph memory nodes
CREATE TABLE IF NOT EXISTS memory_nodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,           -- fact|preference|decision|identity|event|observation|goal|task|error|pattern|dependency|file_change
  content TEXT NOT NULL,        -- The memory text
  source_conversation TEXT,     -- conversation_id where this was extracted
  source_channel TEXT,          -- Which channel
  importance REAL DEFAULT 0.5,  -- 0.0-1.0, decays over time, boosted on access
  access_count INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  accessed_at INTEGER NOT NULL, -- Last time this memory was retrieved and used
  expires_at INTEGER            -- Optional TTL (null = permanent)
);

CREATE INDEX IF NOT EXISTS idx_memory_nodes_type ON memory_nodes(type);
CREATE INDEX IF NOT EXISTS idx_memory_nodes_importance ON memory_nodes(importance DESC);

-- Edges between memory nodes
CREATE TABLE IF NOT EXISTS memory_edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id INTEGER NOT NULL REFERENCES memory_nodes(id) ON DELETE CASCADE,
  target_id INTEGER NOT NULL REFERENCES memory_nodes(id) ON DELETE CASCADE,
  type TEXT NOT NULL,           -- related_to|updates|contradicts|caused_by|part_of|resolved_by|depends_on|supersedes|relates_to
  created_at INTEGER NOT NULL,
  UNIQUE(source_id, target_id, type)
);

CREATE INDEX IF NOT EXISTS idx_memory_edges_source ON memory_edges(source_id);
CREATE INDEX IF NOT EXISTS idx_memory_edges_target ON memory_edges(target_id);

-- FTS5 for memory node search
CREATE VIRTUAL TABLE IF NOT EXISTS memory_nodes_fts USING fts5(
  content, type, content=memory_nodes, content_rowid=id
);

-- Triggers to keep FTS in sync
CREATE TRIGGER IF NOT EXISTS memory_nodes_ai AFTER INSERT ON memory_nodes BEGIN
  INSERT INTO memory_nodes_fts(rowid, content, type) VALUES (new.id, new.content, new.type);
END;

CREATE TRIGGER IF NOT EXISTS memory_nodes_ad AFTER DELETE ON memory_nodes BEGIN
  INSERT INTO memory_nodes_fts(memory_nodes_fts, rowid, content, type) VALUES('delete', old.id, old.content, old.type);
END;

CREATE TRIGGER IF NOT EXISTS memory_nodes_au AFTER UPDATE ON memory_nodes BEGIN
  INSERT INTO memory_nodes_fts(memory_nodes_fts, rowid, content, type) VALUES('delete', old.id, old.content, old.type);
  INSERT INTO memory_nodes_fts(rowid, content, type) VALUES (new.id, new.content, new.type);
END;
