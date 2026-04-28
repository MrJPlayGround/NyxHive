import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthEnv } from "../auth/types.js";
import { CompiledKnowledgeStore } from "../memory/compiled-knowledge.js";
import { KnowledgeStore } from "../memory/knowledge.js";
import { knowledgeRoutes } from "../server/routes/knowledge.js";

function withAuth(role: "owner" | "viewer"): Hono<AuthEnv> {
	const app = new Hono<AuthEnv>();
	app.use("/*", async (c, next) => {
		c.set("auth" as never, { type: "api_key", role } as never);
		return next();
	});
	return app;
}

describe("compiled knowledge routes", () => {
	let dir: string;
	let knowledge: KnowledgeStore;
	let compiled: CompiledKnowledgeStore;
	let app: Hono<AuthEnv>;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "nyxhive-compiled-knowledge-"));
		knowledge = new KnowledgeStore(dir, "test", 4);
		compiled = new CompiledKnowledgeStore(new Database(":memory:"));
		app = withAuth("owner");
		app.route("/api/knowledge", knowledgeRoutes(knowledge, undefined, undefined, compiled));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("compiles and returns a digest page for a source path", async () => {
		knowledge.upsertChunk(
			"Nyx Runbook",
			"Bootstrap",
			"Start the gateway before relaunching remote instances.",
			"runbook",
			"docs/runbook.md",
			"hash-1",
			new Float32Array([1, 0, 0, 0]),
			undefined,
			undefined,
			undefined,
			0,
		);
		knowledge.upsertChunk(
			"Nyx Runbook",
			"Verify",
			"Confirm /health and /api/info after every restart.",
			"runbook",
			"docs/runbook.md",
			"hash-2",
			new Float32Array([0, 1, 0, 0]),
			undefined,
			undefined,
			undefined,
			1,
		);

		const compileRes = await app.request("/api/knowledge/digests/compile", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ source_path: "docs/runbook.md" }),
		});
		expect(compileRes.status).toBe(200);
		const compileBody = await compileRes.json() as { page: { id: number; title: string; chunk_count: number } };
		expect(compileBody.page.title).toBe("Nyx Runbook");
		expect(compileBody.page.chunk_count).toBe(2);

		const listRes = await app.request("/api/knowledge/digests");
		expect(listRes.status).toBe(200);
		const listBody = await listRes.json() as { pages: Array<{ id: number }> };
		expect(listBody.pages).toHaveLength(1);

		const pageRes = await app.request(`/api/knowledge/digests/${compileBody.page.id}`);
		expect(pageRes.status).toBe(200);
		const pageBody = await pageRes.json() as { content: string; access_count: number };
		expect(pageBody.content).toContain("## Highlights");
		expect(pageBody.access_count).toBe(1);
	});

	test("blocks viewer role from compiling digests", async () => {
		const viewerApp = withAuth("viewer");
		viewerApp.route("/api/knowledge", knowledgeRoutes(knowledge, undefined, undefined, compiled));

		const res = await viewerApp.request("/api/knowledge/digests/compile", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ source_path: "docs/runbook.md" }),
		});

		expect(res.status).toBe(403);
	});
});
