/**
 * Session persistence for nyx chat.
 * Stores session state locally so sessions survive terminal close.
 */
import { readFile, writeFile, mkdir, readdir, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const SESSIONS_DIR = join(homedir(), ".nyx", "sessions");
const LAST_SESSION_FILE = join(SESSIONS_DIR, ".last");

export interface LocalSession {
  session_id: string;
  instance: string;
  host: string;
  agent?: string;
  created_at: number;
  updated_at: number;
  message_count: number;
  title?: string;
  cost_cents: number;
}

async function ensureDir() {
  await mkdir(SESSIONS_DIR, { recursive: true });
}

export async function saveSession(session: LocalSession): Promise<void> {
  await ensureDir();
  const file = join(SESSIONS_DIR, `${session.session_id}.json`);
  await writeFile(file, JSON.stringify(session, null, 2), "utf-8");
  await writeFile(LAST_SESSION_FILE, session.session_id, "utf-8");
}

export async function loadSession(sessionId: string): Promise<LocalSession | null> {
  const file = join(SESSIONS_DIR, `${sessionId}.json`);
  if (!existsSync(file)) return null;
  try {
    const raw = await readFile(file, "utf-8");
    return JSON.parse(raw) as LocalSession;
  } catch {
    return null;
  }
}

export async function loadLastSession(): Promise<LocalSession | null> {
  if (!existsSync(LAST_SESSION_FILE)) return null;
  try {
    const id = (await readFile(LAST_SESSION_FILE, "utf-8")).trim();
    return loadSession(id);
  } catch {
    return null;
  }
}

export async function listSessions(): Promise<LocalSession[]> {
  await ensureDir();
  try {
    const files = await readdir(SESSIONS_DIR);
    const sessions: LocalSession[] = [];
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      try {
        const raw = await readFile(join(SESSIONS_DIR, f), "utf-8");
        sessions.push(JSON.parse(raw) as LocalSession);
      } catch {
        // skip corrupt
      }
    }
    return sessions.sort((a, b) => b.updated_at - a.updated_at);
  } catch {
    return [];
  }
}

export async function deleteSession(sessionId: string): Promise<boolean> {
  const file = join(SESSIONS_DIR, `${sessionId}.json`);
  if (!existsSync(file)) return false;
  await unlink(file);
  return true;
}
