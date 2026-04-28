import type { Database } from "bun:sqlite";

const STALE_CLAIM_MS = 2 * 60 * 60 * 1000; // 2 hours

export interface WorkClaim {
	key: string;
	agent: string;
	claimed_at: number;
	released_at: number | null;
	progress_pct: number;
	progress_msg: string | null;
	updated_at: number;
}

export interface AgentQuestion {
	id: number;
	agent: string;
	question: string;
	context: string | null;
	answered: number;
	answer: string | null;
	created_at: number;
	answered_at: number | null;
}

export class CoordinationStore {
	private db: Database;

	constructor(db: Database) {
		this.db = db;
		this.init();
	}

	private init(): void {
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS work_claims (
				key TEXT PRIMARY KEY,
				agent TEXT NOT NULL,
				claimed_at INTEGER NOT NULL,
				released_at INTEGER,
				progress_pct INTEGER DEFAULT 0,
				progress_msg TEXT,
				updated_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS agent_questions (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				agent TEXT NOT NULL,
				question TEXT NOT NULL,
				context TEXT,
				answered INTEGER DEFAULT 0,
				answer TEXT,
				created_at INTEGER NOT NULL,
				answered_at INTEGER
			);
		`);
	}

	claim(key: string, agent: string): boolean {
		const now = Date.now();
		// Auto-prune stale claims first
		this.db.run("DELETE FROM work_claims WHERE released_at IS NULL AND updated_at < ?", [now - STALE_CLAIM_MS]);

		try {
			this.db.run(
				"INSERT INTO work_claims (key, agent, claimed_at, updated_at) VALUES (?, ?, ?, ?)",
				[key, agent, now, now],
			);
			return true;
		} catch {
			// UNIQUE constraint violation — already claimed
			return false;
		}
	}

	release(key: string, agent: string): boolean {
		const now = Date.now();
		const result = this.db.run(
			"UPDATE work_claims SET released_at = ?, updated_at = ? WHERE key = ? AND agent = ? AND released_at IS NULL",
			[now, now, key, agent],
		);
		return result.changes > 0;
	}

	postProgress(key: string, agent: string, pct: number, msg: string): boolean {
		const now = Date.now();
		const result = this.db.run(
			"UPDATE work_claims SET progress_pct = ?, progress_msg = ?, updated_at = ? WHERE key = ? AND agent = ? AND released_at IS NULL",
			[pct, msg, now, key, agent],
		);
		return result.changes > 0;
	}

	getActiveClaims(): WorkClaim[] {
		const now = Date.now();
		// Auto-prune stale claims
		this.db.run("DELETE FROM work_claims WHERE released_at IS NULL AND updated_at < ?", [now - STALE_CLAIM_MS]);
		return this.db.query("SELECT * FROM work_claims WHERE released_at IS NULL ORDER BY claimed_at DESC").all() as WorkClaim[];
	}

	askQuestion(agent: string, question: string, context?: string): number {
		const now = Date.now();
		const result = this.db.run(
			"INSERT INTO agent_questions (agent, question, context, created_at) VALUES (?, ?, ?, ?)",
			[agent, question, context ?? null, now],
		);
		return Number(result.lastInsertRowid);
	}

	getPendingQuestions(): AgentQuestion[] {
		return this.db.query("SELECT * FROM agent_questions WHERE answered = 0 ORDER BY created_at DESC").all() as AgentQuestion[];
	}
}
