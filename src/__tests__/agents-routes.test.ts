import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Hono } from "hono";
import type { AuthEnv } from "../auth/types.js";
import { AgentRegistry } from "../agents/registry.js";
import { agentsRoutes } from "../server/routes/agents.js";
import { clearSoulCache } from "../soul/runtime.js";

function withAuth(app: Hono, basePath: string): Hono<AuthEnv> {
  const wrapper = new Hono<AuthEnv>();
  wrapper.use("/*", async (c, next) => {
    c.set("auth" as never, { type: "api_key", role: "owner" } as never);
    return next();
  });
  wrapper.route(basePath, app);
  return wrapper;
}

describe("agents routes", () => {
  let db: Database;
  let registry: AgentRegistry;
  let instanceSoulsDir: string;
  let app: Hono<AuthEnv>;
  let agentKey: string;
  let agentSoulPath: string;

  beforeEach(() => {
    clearSoulCache();
    db = new Database(":memory:");
    instanceSoulsDir = mkdtempSync(join(tmpdir(), "agents-route-instance-soul-test-"));
    agentKey = `agents_route_${Date.now()}`;
    agentSoulPath = join(process.cwd(), "souls", `${agentKey}.yaml`);
    writeFileSync(
      agentSoulPath,
      `identity:\n  name: Agents Route\n  role: worker\ncapabilities:\n  can_delegate: false\n`,
    );
    writeFileSync(
      join(instanceSoulsDir, "instance.yaml"),
      `context:\n  instance_notes: "Loaded from agents route override"\n`,
    );
    registry = new AgentRegistry(
      db,
      {
        [agentKey]: {
          name: "Agents Route",
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          working_directory: `/tmp/${agentKey}`,
        },
      },
      undefined,
      undefined,
      "/tmp",
      instanceSoulsDir,
    );
    app = withAuth(
      agentsRoutes(
        {
          agents: {
            [agentKey]: {
              name: "Agents Route",
              provider: "anthropic",
              model: "claude-sonnet-4-6",
              working_directory: `/tmp/${agentKey}`,
            },
          },
        } as any,
        registry,
        undefined,
        instanceSoulsDir,
      ),
      "/api/agents",
    );
  });

  afterEach(() => {
    clearSoulCache();
    db.close();
    rmSync(agentSoulPath, { force: true });
    rmSync(instanceSoulsDir, { recursive: true, force: true });
  });

  it("returns compiled soul data with instance-specific overrides", async () => {
    const res = await app.request(`/api/agents/${agentKey}/soul`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.agent).toBe(agentKey);
    expect(body.context.instance_notes).toBe("Loaded from agents route override");
  });
});
