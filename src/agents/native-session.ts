/**
 * Persistent conversation history for the native API execution path.
 *
 * Claude CLI achieves session continuity via `--resume <sessionId>` — history
 * lives server-side in ~/.claude/sessions/. Native API has no server-side session
 * concept, so the harness manages it: after each invocation we serialize the
 * messages array (user/assistant/tool turns) to a file in the agent workspace,
 * and load it on the next invocation for the same conversation.
 *
 * Storage: {workDir}/.sessions/{sessionId}.json
 * Expiry: sessions older than SESSION_TTL_MS are treated as stale and discarded.
 * Cap: we keep the last MAX_SESSION_MESSAGES messages to prevent unbounded growth.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { logger } from "../utils/logger.js";

// ── Constants ──

/** Sessions expire after 30 minutes of inactivity (matches CLI session TTL in processor). */
const SESSION_TTL_MS = 30 * 60 * 1000;

/** Keep at most this many messages to prevent unbounded context growth (~50 turns). */
const MAX_SESSION_MESSAGES = 100;

/**
 * When the session exceeds this many messages, compress middle turns.
 * ForgeCode principle: context pressure management — compress old tool-heavy turns
 * so the model's attention stays on recent context rather than stale history.
 */
const COMPRESS_THRESHOLD = 50;
/** First N messages are always kept verbatim — they contain the original task context. */
const KEEP_EARLY = 4;
/** Last N messages are always kept verbatim — they represent the current working state. */
const KEEP_RECENT = 20;

const SESSIONS_DIR = ".sessions";

// ── Types ──

/** OpenAI-compatible message (must match the APIMessage type in invoke-native-api.ts) */
export interface SessionMessage {
  role: "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

export interface NativeSession {
  sessionId: string;
  agentKey: string;
  /** Conversation turns: user, assistant, and tool messages (system excluded — rebuilt fresh each time). */
  messages: SessionMessage[];
  createdAt: number;
  updatedAt: number;
}

// ── Compression ──

/**
 * Compress a session's message history when it exceeds COMPRESS_THRESHOLD.
 *
 * Strategy:
 * - Keep the first KEEP_EARLY messages (original task + initial context)
 * - Keep the last KEEP_RECENT messages verbatim (current working state)
 * - Replace the middle section with a single summary marker that lists the tools
 *   used and reminds the model that the file system reflects the completed work.
 *
 * This prevents context floods from accumulated tool results in long sessions,
 * which is the primary cause of degraded conversation quality in GPT agents.
 */
export function compressNativeSession(messages: SessionMessage[]): SessionMessage[] {
  if (messages.length <= COMPRESS_THRESHOLD) return messages;

  const early = messages.slice(0, KEEP_EARLY);
  const recent = messages.slice(-KEEP_RECENT);
  const middle = messages.slice(KEEP_EARLY, messages.length - KEEP_RECENT);

  if (middle.length < 5) return messages;

  // Collect tool names used in the middle section for the summary
  const toolsUsed = middle
    .filter((m) => m.tool_calls?.length)
    .flatMap((m) => m.tool_calls!.map((tc) => tc.function.name));
  const uniqueTools = [...new Set(toolsUsed)];

  const parts: string[] = [
    `[context-compressed: ${middle.length} messages from an earlier phase of this session have been condensed to preserve context window]`,
  ];
  if (uniqueTools.length > 0) {
    parts.push(`Tools used in compressed section: ${uniqueTools.join(", ")}`);
  }
  parts.push(
    "The file system and codebase reflect the results of that work. Refer to existing files for state — not this summary.",
  );

  const summary: SessionMessage = { role: "user", content: parts.join("\n") };

  logger.debug(
    `[native-session] Compressed ${middle.length} middle messages (${early.length} early + summary + ${recent.length} recent kept)`,
  );

  return [...early, summary, ...recent];
}

// ── I/O ──

function sessionsDir(workDir: string): string {
  return join(workDir, SESSIONS_DIR);
}

function sessionPath(workDir: string, sessionId: string): string {
  return join(sessionsDir(workDir), `${sessionId}.json`);
}

/**
 * Load a session. Returns null if:
 * - file doesn't exist
 * - session has expired
 * - file is corrupt
 */
export function loadNativeSession(workDir: string, sessionId: string): NativeSession | null {
  const path = sessionPath(workDir, sessionId);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    const session = JSON.parse(raw) as NativeSession;
    if (Date.now() - session.updatedAt > SESSION_TTL_MS) {
      logger.debug(`[native-session] Session ${sessionId} expired (${Math.round((Date.now() - session.updatedAt) / 60000)}m idle)`);
      return null;
    }
    return session;
  } catch (err) {
    logger.warn(`[native-session] Failed to load session ${sessionId}: ${err}`);
    return null;
  }
}

/**
 * Save (or update) a session. Trims to MAX_SESSION_MESSAGES before writing.
 */
export function saveNativeSession(
  workDir: string,
  sessionId: string,
  agentKey: string,
  messages: SessionMessage[],
  existingSession?: NativeSession | null,
): void {
  // Compress middle turns when session gets long (ForgeCode context pressure management).
  // Do this before the hard cap so we preserve early + recent context intelligently.
  const compressed = compressNativeSession(messages);

  // Hard cap: trim to most recent messages as a final safety net
  const trimmed = compressed.length > MAX_SESSION_MESSAGES
    ? compressed.slice(compressed.length - MAX_SESSION_MESSAGES)
    : compressed;

  const now = Date.now();
  const session: NativeSession = {
    sessionId,
    agentKey,
    messages: trimmed,
    createdAt: existingSession?.createdAt ?? now,
    updatedAt: now,
  };

  try {
    const dir = sessionsDir(workDir);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(sessionPath(workDir, sessionId), JSON.stringify(session, null, 2), "utf-8");
  } catch (err) {
    logger.warn(`[native-session] Failed to save session ${sessionId}: ${err}`);
  }
}

/**
 * Generate a new session ID.
 */
export function newNativeSessionId(): string {
  return randomUUID();
}
