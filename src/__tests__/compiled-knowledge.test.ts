import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { CompiledKnowledgeStore, compileKnowledgeDigest, compileProceduralSkillDigest, formatCompiledKnowledgeContext } from "../memory/compiled-knowledge.js";

function createStore() {
	return new CompiledKnowledgeStore(new Database(":memory:"));
}

describe("compiled knowledge", () => {
	test("builds a compact digest from ordered knowledge chunks", () => {
		const digest = compileKnowledgeDigest("docs/runbook.md", [
			{
				id: 1,
				title: "Nyx Runbook",
				section: "Bootstrap",
				content: "Start the gateway before relaunching remote instances.",
				category: "runbook",
				source_path: "docs/runbook.md",
				content_hash: "hash-1",
				chunk_index: 0,
			},
			{
				id: 2,
				title: "Nyx Runbook",
				section: "Verify",
				content: "Confirm /health and /api/info after every restart.",
				category: "runbook",
				source_path: "docs/runbook.md",
				content_hash: "hash-2",
				chunk_index: 1,
			},
		]);

		expect(digest.title).toBe("Nyx Runbook");
		expect(digest.summary).toContain("Bootstrap");
		expect(digest.content).toContain("## Key Sections");
		expect(digest.chunkCount).toBe(2);
	});

	test("upserts and queries compiled knowledge pages", () => {
		const store = createStore();
		const created = store.upsert({
			sourceKey: "docs/runbook.md",
			sourcePath: "docs/runbook.md",
			title: "Nyx Runbook",
			category: "runbook",
			summary: "Bootstrap • Verify",
			content: "# Nyx Runbook",
			sourceHash: "hash-a",
			chunkCount: 2,
		});

		expect(created.id).toBeGreaterThan(0);
		expect(store.count()).toBe(1);
		expect(store.list({ query: "Runbook" })[0]?.id).toBe(created.id);

		const updated = store.upsert({
			sourceKey: "docs/runbook.md",
			sourcePath: "docs/runbook.md",
			title: "Nyx Runbook",
			category: "runbook",
			summary: "Bootstrap • Verify • Recover",
			content: "# Nyx Runbook\n\nUpdated",
			sourceHash: "hash-b",
			chunkCount: 3,
		});

		expect(updated.id).toBe(created.id);
		expect(store.getBySourceKey("docs/runbook.md")?.chunk_count).toBe(3);
		expect(store.getById(created.id)?.access_count).toBe(1);
	});

	test("ranks path-aware digest matches above generic pages", () => {
		const store = createStore();
		store.upsert({
			sourceKey: "src/gateway/chat.md",
			sourcePath: "src/gateway/chat.md",
			title: "Gateway Chat Runbook",
			category: "runbook",
			summary: "Fix websocket reconnect and thread loading issues",
			content: "# Gateway Chat Runbook\n\n## Highlights\n- Repair websocket reconnect loops",
			sourceHash: "hash-chat",
			chunkCount: 2,
		});
		store.upsert({
			sourceKey: "docs/general.md",
			sourcePath: "docs/general.md",
			title: "General Engineering Notes",
			category: "notes",
			summary: "General fix and verify workflow",
			content: "# General Engineering Notes",
			sourceHash: "hash-general",
			chunkCount: 1,
		});

		const [first] = store.search("fix the gateway websocket reconnect issue", {
			filePaths: ["src/gateway/src/stores/fleet-chat.ts"],
			keywords: ["gateway", "websocket", "reconnect"],
			taskType: "debug",
		});

		expect(first?.page.source_path).toBe("src/gateway/chat.md");
		expect(first?.score).toBeGreaterThan(4);
	});

	test("formats compiled digest context for prompt injection", () => {
		const context = formatCompiledKnowledgeContext([
			{
				id: 1,
				source_key: "docs/runbook.md",
				source_path: "docs/runbook.md",
				title: "Nyx Runbook",
				category: "runbook",
				summary: "Bootstrap • Verify",
				content: "# Nyx Runbook\n\n## Key Sections\n- Bootstrap\n\n## Highlights\n- Start the gateway first",
				source_hash: "hash-1",
				chunk_count: 2,
				stale: 0,
				created_at: 1,
				updated_at: 1,
				last_accessed_at: null,
				access_count: 0,
			},
		]);

		expect(context).toContain("[Compiled knowledge digests]");
		expect(context).toContain("[[Nyx Runbook]]");
		expect(context).toContain("docs/runbook.md");
	});

	test("audits stale pages against current source chunks", () => {
		const store = createStore();
		const page = store.upsert({
			sourceKey: "docs/runbook.md",
			sourcePath: "docs/runbook.md",
			title: "Nyx Runbook",
			category: "runbook",
			summary: "Bootstrap",
			content: "# Nyx Runbook",
			sourceHash: "old-hash",
			chunkCount: 1,
		});

		const result = store.auditStaleness((sourcePath) => [
			{
				id: 1,
				title: "Nyx Runbook",
				section: "Bootstrap",
				content: "Changed bootstrap procedure.",
				category: "runbook",
				source_path: sourcePath,
				content_hash: "new-hash",
				chunk_index: 0,
			},
		]);

		expect(result).toEqual({
			checked: 1,
			markedStale: 1,
			restoredFresh: 0,
			missingSources: 0,
		});
		expect(store.getBySourceKey(page.source_key)?.stale).toBe(1);
	});

	test("compiles procedural skill drafts into searchable workflow digests", () => {
		const store = createStore();
		const digest = compileProceduralSkillDigest({
			id: 7,
			source_hash: "workflow-hash-1234567890",
			agent_key: "nyx",
			conversation_id: "gateway:thread-1",
			trace_id: "trace-1",
			title: "Workflow: Stabilize cockpit reconnect path",
			summary: "Reconnect and websocket verification workflow.",
			draft_markdown: "# Stabilize cockpit reconnect path\n\n1. Reproduce websocket reconnect churn.\n2. Run `bun run typecheck`.",
			status: "draft",
			published_skill_name: null,
			rejected_reason: null,
			usage_count: 0,
			success_count: 0,
			created_at: "2026-04-10 00:00:00",
			updated_at: "2026-04-10 00:00:00",
			published_at: null,
			last_used_at: null,
			last_success_at: null,
		});

		const page = store.upsert(digest);
		const [hit] = store.search("cockpit reconnect websocket workflow", {
			keywords: ["cockpit", "reconnect", "websocket"],
			taskType: "debug",
		});

		expect(page.source_key).toBe("procedural-skill:workflow-hash-1234567890");
		expect(page.category).toBe("workflow");
		expect(page.content).toContain("Source: procedural skill draft 7");
		expect(hit?.page.id).toBe(page.id);
	});
});
