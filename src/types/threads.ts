export const THREAD_STATUSES = [
  "created",
  "queued",
  "processing",
  "waiting_input",
  "completed",
  "failed",
  "cancelled",
] as const;

export type ThreadStatus = (typeof THREAD_STATUSES)[number];

export interface Thread {
  id: string;
  title: string;
  project_id: string | null;
  instance: string;
  agent: string | null;
  status: ThreadStatus;
  message: string;
  response: string | null;
  message_id: string | null;
  trace_id: string | null;
  cost_cents: number;
  total_tokens: number;
  duration_ms: number | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
  archived: boolean;
  branch: string | null;
  base_branch: string | null;
  worktree_path: string | null;
  commit_hash: string | null;
  pr_url: string | null;
  category: string | null;
  metadata: Record<string, unknown> | null;
  messages?: ThreadMessage[];
}

export interface ThreadMessage {
  id: string;
  thread_id: string;
  role: "user" | "assistant" | "system";
  content: string;
  agent: string | null;
  message_id: string | null;
  trace_id: string | null;
  cost_cents: number;
  tokens: number;
  timestamp: number;
}

export interface Project {
  id: string;
  name: string;
  instance: string;
  repo_path: string | null;
  default_agent: string | null;
  created_at: number;
  updated_at: number;
}

/** Fields for creating a new thread */
export interface NewThread {
  title?: string;
  project_id?: string;
  instance: string;
  agent?: string;
  message: string;
  metadata?: Record<string, unknown>;
}

/** Fields for creating a new thread message */
export interface NewThreadMessage {
  role: "user" | "assistant" | "system";
  content: string;
  agent?: string;
  message_id?: string;
  trace_id?: string;
  cost_cents?: number;
  tokens?: number;
}

/** Fields for creating a new project */
export interface NewProject {
  name: string;
  instance: string;
  repo_path?: string;
  default_agent?: string;
}

export interface FileChange {
  id: string;
  threadId: string;
  messageId?: string;
  filePath: string;
  operation: 'write' | 'edit' | 'create' | 'delete';
  linesAdded: number;
  linesRemoved: number;
  diffSummary?: string;
  timestamp: number;
}

export interface ThreadExecutionEventChange {
  path: string;
  kind: "add" | "delete" | "update";
}

export interface ThreadExecutionEvent {
  id: string;
  threadId: string;
  messageId?: string;
  kind: "command" | "file_change" | "mcp_tool" | "web_search" | "status";
  phase: "started" | "updated" | "completed" | "failed";
  turn?: number;
  title: string;
  subtitle?: string;
  details?: string;
  command?: string;
  outputPreview?: string;
  exitCode?: number | null;
  changes?: ThreadExecutionEventChange[];
  timestamp: number;
}

/** Raw thread row from SQLite (archived is INTEGER, not boolean) */
export interface ThreadRow {
  id: string;
  title: string;
  project_id: string | null;
  instance: string;
  agent: string | null;
  status: ThreadStatus;
  message: string;
  response: string | null;
  message_id: string | null;
  trace_id: string | null;
  cost_cents: number;
  total_tokens: number;
  duration_ms: number | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
  archived: number;
  branch: string | null;
  base_branch: string | null;
  worktree_path: string | null;
  commit_hash: string | null;
  pr_url: string | null;
  category: string | null;
  metadata: string | null;
}
