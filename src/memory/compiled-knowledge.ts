import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { basename } from "node:path";
import { ensureTableSchema } from "../utils/schema.js";
import type { KnowledgeChunk, KnowledgeTaskContext } from "./knowledge.js";
import type { ProceduralSkillDraft } from "./procedural-skills.js";

export interface CompiledKnowledgePage {
	id: number;
	source_key: string;
	source_path: string;
	title: string;
	category: string | null;
	summary: string;
	content: string;
	source_hash: string;
	chunk_count: number;
	stale: number;
	created_at: number;
	updated_at: number;
	last_accessed_at: number | null;
	access_count: number;
}

export interface CompiledKnowledgeInput {
	sourceKey: string;
	sourcePath: string;
	title: string;
	category?: string | null;
	summary: string;
	content: string;
	sourceHash: string;
	chunkCount: number;
}

export interface CompiledKnowledgeSearchResult {
	page: CompiledKnowledgePage;
	score: number;
}

export interface CompiledKnowledgeAuditResult {
	checked: number;
	markedStale: number;
	restoredFresh: number;
	missingSources: number;
}

const COMPILED_KNOWLEDGE_MIN_SCORE = 4;

function normalizeSearchTokens(input: string): string[] {
	return Array.from(
		new Set(
			input
				.toLowerCase()
				.split(/[^a-z0-9/_-]+/)
				.map((token) => token.trim())
				.filter((token) => token.length >= 3),
		),
	);
}

function collectPathHints(taskContext?: KnowledgeTaskContext): string[] {
	if (!taskContext?.filePaths?.length) return [];
	return Array.from(
		new Set(
			taskContext.filePaths.flatMap((filePath) =>
				filePath
					.split(/[\\/]/)
					.map((segment) => segment.toLowerCase().trim())
					.filter((segment) => segment.length >= 2),
			),
		),
	);
}

function scoreCompiledKnowledgePage(
	page: CompiledKnowledgePage,
	queryTokens: string[],
	taskContext?: KnowledgeTaskContext,
): number {
	const title = page.title.toLowerCase();
	const sourcePath = page.source_path.toLowerCase();
	const summary = page.summary.toLowerCase();
	const content = page.content.toLowerCase();
	const haystack = `${title}\n${sourcePath}\n${summary}\n${content}`;
	let score = page.stale ? -6 : 0;

	for (const token of queryTokens) {
		if (sourcePath.includes(token)) score += 5;
		else if (title.includes(token)) score += 4;
		else if (summary.includes(token)) score += 3;
		else if (content.includes(token)) score += 1;
	}

	for (const pathHint of collectPathHints(taskContext)) {
		if (sourcePath.includes(pathHint)) score += 6;
		else if (title.includes(pathHint) || summary.includes(pathHint)) score += 2;
	}

	for (const keyword of taskContext?.keywords ?? []) {
		const normalized = keyword.toLowerCase();
		if (normalized.length < 3) continue;
		if (title.includes(normalized) || summary.includes(normalized)) score += 2;
		else if (content.includes(normalized)) score += 1;
	}

	if (taskContext?.categoryBoost?.includes(page.category ?? "")) {
		score += 3;
	}

	if (taskContext?.taskType) {
		const taskType = taskContext.taskType.toLowerCase();
		if (haystack.includes(taskType)) score += 2;
	}

	score += Math.min(page.access_count, 4);
	return score;
}

export function formatCompiledKnowledgeContext(pages: CompiledKnowledgePage[]): string | null {
	if (pages.length === 0) return null;
	return [
		"[Compiled knowledge digests]",
		...pages.map((page) => {
			const lines = page.content
				.split("\n")
				.filter((line) => line.trim().length > 0)
				.slice(0, 8);
			return [
				`[Digest: [[${page.title}]]${page.category ? ` -- ${page.category}` : ""}]`,
				`[Source path] ${page.source_path}`,
				page.summary ? `[Summary] ${page.summary}` : null,
				...[lines.length > 0 ? ["[Digest body]", ...lines] : []],
			]
				.filter((line): line is string => Boolean(line))
				.join("\n");
		}),
	].join("\n\n");
}

export function compileKnowledgeDigest(sourcePath: string, chunks: KnowledgeChunk[]) {
	const ordered = [...chunks].sort((left, right) => (left.chunk_index ?? 0) - (right.chunk_index ?? 0));
	const first = ordered[0];
	const title = first?.title?.trim() || basename(sourcePath);
	const sections = new Set<string>();
	const highlights: string[] = [];
	const categoryCounts = new Map<string, number>();

	for (const chunk of ordered) {
		if (chunk.category) {
			categoryCounts.set(chunk.category, (categoryCounts.get(chunk.category) ?? 0) + 1);
		}
		const section = chunk.section?.trim();
		if (section) sections.add(section);
		const normalized = chunk.content
			.replace(/\s+/g, " ")
			.replace(/^#+\s*/g, "")
			.trim();
		if (!normalized) continue;
		const prefix = section ? `${section}: ` : "";
		highlights.push(`${prefix}${normalized.slice(0, 220).trim()}`);
	}

	const category = [...categoryCounts.entries()]
		.sort((left, right) => right[1] - left[1])[0]?.[0] ?? first?.category ?? null;
	const summaryParts = Array.from(sections).slice(0, 3);
	if (summaryParts.length === 0 && highlights.length > 0) {
		summaryParts.push(highlights[0]!.slice(0, 140));
	}
	const summary = summaryParts.join(" • ").slice(0, 280);
	const content = [
		`# ${title}`,
		"",
		`Source: ${sourcePath}`,
		"",
		"## Key Sections",
		...Array.from(sections).slice(0, 8).map((section) => `- ${section}`),
		"",
		"## Highlights",
		...highlights.slice(0, 8).map((line) => `- ${line}`),
	].join("\n").trim();
	const sourceHash = createHash("sha256")
		.update(`${sourcePath}\n${ordered.map((chunk) => chunk.content_hash).join("\n")}`)
		.digest("hex");

	return {
		sourceKey: sourcePath,
		sourcePath,
		title,
		category,
		summary,
		content,
		sourceHash,
		chunkCount: ordered.length,
	};
}

export function compileProceduralSkillDigest(draft: ProceduralSkillDraft): CompiledKnowledgeInput {
	const status = draft.status === "published" && draft.published_skill_name
		? `published as ${draft.published_skill_name}`
		: draft.status;
	const title = draft.title.trim() || "Procedural workflow";
	const sourcePath = `procedural-skills/${draft.agent_key}/${draft.source_hash.slice(0, 12)}.md`;
	const content = [
		`# ${title}`,
		"",
		`Source: procedural skill draft ${draft.id}`,
		`Agent: ${draft.agent_key}`,
		`Status: ${status}`,
		draft.trace_id ? `Trace: ${draft.trace_id}` : null,
		draft.conversation_id ? `Conversation: ${draft.conversation_id}` : null,
		"",
		"## Workflow summary",
		draft.summary,
		"",
		"## Draft procedure",
		draft.draft_markdown,
	]
		.filter((line): line is string => line !== null)
		.join("\n")
		.trim();
	const sourceHash = createHash("sha256")
		.update([
			draft.source_hash,
			draft.status,
			draft.published_skill_name ?? "",
			draft.draft_markdown,
		].join("\n"))
		.digest("hex");

	return {
		sourceKey: `procedural-skill:${draft.source_hash}`,
		sourcePath,
		title,
		category: "workflow",
		summary: draft.summary,
		content,
		sourceHash,
		chunkCount: 1,
	};
}

export class CompiledKnowledgeStore {
	constructor(private db: Database) {
		this.init();
	}

	private init() {
		ensureTableSchema(this.db, {
			table: "compiled_knowledge_pages",
			required: [
				"source_key",
				"source_path",
				"title",
				"category",
				"summary",
				"content",
				"source_hash",
				"chunk_count",
				"stale",
				"created_at",
				"updated_at",
				"last_accessed_at",
				"access_count",
			],
			ephemeral: false,
			columnDefs: {
				source_key: "TEXT NOT NULL DEFAULT '' UNIQUE",
				source_path: "TEXT NOT NULL DEFAULT ''",
				title: "TEXT NOT NULL DEFAULT ''",
				category: "TEXT",
				summary: "TEXT NOT NULL DEFAULT ''",
				content: "TEXT NOT NULL DEFAULT ''",
				source_hash: "TEXT NOT NULL DEFAULT ''",
				chunk_count: "INTEGER NOT NULL DEFAULT 0",
				stale: "INTEGER NOT NULL DEFAULT 0",
				created_at: "INTEGER NOT NULL DEFAULT 0",
				updated_at: "INTEGER NOT NULL DEFAULT 0",
				last_accessed_at: "INTEGER",
				access_count: "INTEGER NOT NULL DEFAULT 0",
			},
		}, "compiled knowledge");
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS compiled_knowledge_pages (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				source_key TEXT NOT NULL UNIQUE,
				source_path TEXT NOT NULL,
				title TEXT NOT NULL,
				category TEXT,
				summary TEXT NOT NULL,
				content TEXT NOT NULL,
				source_hash TEXT NOT NULL,
				chunk_count INTEGER NOT NULL DEFAULT 0,
				stale INTEGER NOT NULL DEFAULT 0,
				created_at INTEGER NOT NULL DEFAULT 0,
				updated_at INTEGER NOT NULL DEFAULT 0,
				last_accessed_at INTEGER,
				access_count INTEGER NOT NULL DEFAULT 0
			);
			CREATE INDEX IF NOT EXISTS idx_compiled_knowledge_updated_at
				ON compiled_knowledge_pages(updated_at DESC);
		`);
	}

	upsert(input: CompiledKnowledgeInput): CompiledKnowledgePage {
		const now = Date.now();
		this.db.prepare(
			`INSERT INTO compiled_knowledge_pages (
				source_key, source_path, title, category, summary, content, source_hash, chunk_count, stale, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
			ON CONFLICT(source_key) DO UPDATE SET
				source_path = excluded.source_path,
				title = excluded.title,
				category = excluded.category,
				summary = excluded.summary,
				content = excluded.content,
				source_hash = excluded.source_hash,
				chunk_count = excluded.chunk_count,
				stale = 0,
				updated_at = excluded.updated_at`,
		).run(
			input.sourceKey,
			input.sourcePath,
			input.title,
			input.category ?? null,
			input.summary,
			input.content,
			input.sourceHash,
			input.chunkCount,
			now,
			now,
		);

		return this.getBySourceKey(input.sourceKey)!;
	}

	getById(id: number): CompiledKnowledgePage | null {
		const row = this.db.prepare(
			"SELECT * FROM compiled_knowledge_pages WHERE id = ?",
		).get(id) as CompiledKnowledgePage | null;
		if (!row) return null;
		this.touch(row.id);
		return this.getByIdNoTouch(row.id);
	}

	private getByIdNoTouch(id: number): CompiledKnowledgePage | null {
		return this.db.prepare(
			"SELECT * FROM compiled_knowledge_pages WHERE id = ?",
		).get(id) as CompiledKnowledgePage | null;
	}

	getBySourceKey(sourceKey: string): CompiledKnowledgePage | null {
		return this.db.prepare(
			"SELECT * FROM compiled_knowledge_pages WHERE source_key = ?",
		).get(sourceKey) as CompiledKnowledgePage | null;
	}

	list(options?: { query?: string; limit?: number; stale?: boolean }): CompiledKnowledgePage[] {
		const limit = Math.min(Math.max(options?.limit ?? 50, 1), 200);
		const filters: string[] = [];
		const params: Array<string | number> = [];
		if (typeof options?.stale === "boolean") {
			filters.push("stale = ?");
			params.push(options.stale ? 1 : 0);
		}
		if (options?.query?.trim()) {
			filters.push("(title LIKE ? OR summary LIKE ? OR content LIKE ? OR source_path LIKE ?)");
			const pattern = `%${options.query.trim()}%`;
			params.push(pattern, pattern, pattern, pattern);
		}
		const where = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
		return this.db.prepare(
			`SELECT * FROM compiled_knowledge_pages ${where} ORDER BY updated_at DESC LIMIT ?`,
		).all(...params, limit) as CompiledKnowledgePage[];
	}

	count(): number {
		return (this.db.prepare("SELECT COUNT(*) AS count FROM compiled_knowledge_pages").get() as { count: number }).count;
	}

	search(query: string, taskContext?: KnowledgeTaskContext, limit = 2): CompiledKnowledgeSearchResult[] {
		const cappedLimit = Math.min(Math.max(limit, 1), 10);
		const queryTokens = normalizeSearchTokens(`${query}\n${taskContext?.keywords?.join(" ") ?? ""}`);
		if (queryTokens.length === 0 && !taskContext?.filePaths?.length) return [];
		return this.list({ limit: 200 })
			.map((page) => ({
				page,
				score: scoreCompiledKnowledgePage(page, queryTokens, taskContext),
			}))
			.filter((entry) => entry.score >= COMPILED_KNOWLEDGE_MIN_SCORE)
			.sort((left, right) => {
				if (right.score !== left.score) return right.score - left.score;
				return right.page.updated_at - left.page.updated_at;
			})
			.slice(0, cappedLimit);
	}

	markStale(id: number, stale: boolean): CompiledKnowledgePage | null {
		this.db.prepare("UPDATE compiled_knowledge_pages SET stale = ?, updated_at = ? WHERE id = ?")
			.run(stale ? 1 : 0, Date.now(), id);
		return this.getByIdNoTouch(id);
	}

	auditStaleness(resolveChunks: (sourcePath: string) => KnowledgeChunk[]): CompiledKnowledgeAuditResult {
		const pages = this.list({ limit: 200 });
		const result: CompiledKnowledgeAuditResult = {
			checked: 0,
			markedStale: 0,
			restoredFresh: 0,
			missingSources: 0,
		};
		for (const page of pages) {
			result.checked += 1;
			const chunks = resolveChunks(page.source_path);
			if (chunks.length === 0) {
				result.missingSources += 1;
				if (page.stale !== 1) {
					this.markStale(page.id, true);
					result.markedStale += 1;
				}
				continue;
			}
			const current = compileKnowledgeDigest(page.source_path, chunks);
			const stale = current.sourceHash !== page.source_hash;
			if (stale && page.stale !== 1) {
				this.markStale(page.id, true);
				result.markedStale += 1;
			} else if (!stale && page.stale === 1) {
				this.markStale(page.id, false);
				result.restoredFresh += 1;
			}
		}
		return result;
	}

	private touch(id: number) {
		this.db.prepare(
			"UPDATE compiled_knowledge_pages SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?",
		).run(Date.now(), id);
	}
}
