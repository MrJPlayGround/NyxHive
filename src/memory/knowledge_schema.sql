CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  section TEXT,
  content TEXT NOT NULL,
  category TEXT,
  source_path TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  embedding BLOB NOT NULL,
  scope TEXT NOT NULL DEFAULT 'global',
  priority INTEGER NOT NULL DEFAULT 1,
  source_agent TEXT,
  source_thread_id TEXT,
  chunk_index INTEGER NOT NULL DEFAULT 0,
  accessed_at INTEGER,
  access_count INTEGER NOT NULL DEFAULT 0,
  confidence REAL NOT NULL DEFAULT 1.0,
  shareable INTEGER NOT NULL DEFAULT 0,
  decision_status TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_source_section_chunk
  ON knowledge_chunks(source_path, section, chunk_index);

CREATE INDEX IF NOT EXISTS idx_knowledge_source_hash
  ON knowledge_chunks(source_path, content_hash);

CREATE INDEX IF NOT EXISTS idx_knowledge_category
  ON knowledge_chunks(category);

CREATE INDEX IF NOT EXISTS idx_knowledge_scope
  ON knowledge_chunks(scope);

CREATE INDEX IF NOT EXISTS idx_knowledge_source_title_chunk
  ON knowledge_chunks(source_path, title, chunk_index);

CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_chunks_fts USING fts5(
  title,
  section,
  content,
  category,
  source_path
);

CREATE TRIGGER IF NOT EXISTS knowledge_chunks_ai AFTER INSERT ON knowledge_chunks BEGIN
  INSERT INTO knowledge_chunks_fts(rowid, title, section, content, category, source_path)
  VALUES (new.id, new.title, new.section, new.content, new.category, new.source_path);
END;

CREATE TRIGGER IF NOT EXISTS knowledge_chunks_ad AFTER DELETE ON knowledge_chunks BEGIN
  DELETE FROM knowledge_chunks_fts WHERE rowid = old.id;
END;

CREATE TRIGGER IF NOT EXISTS knowledge_chunks_au AFTER UPDATE ON knowledge_chunks BEGIN
  DELETE FROM knowledge_chunks_fts WHERE rowid = old.id;
  INSERT INTO knowledge_chunks_fts(rowid, title, section, content, category, source_path)
  VALUES (new.id, new.title, new.section, new.content, new.category, new.source_path);
END;
