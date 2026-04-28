import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { configRoutes } from "../server/routes/config.js";
import type { AuthEnv } from "../auth/types.js";
import type { NyxHiveConfig } from "../types.js";

function baseConfig(): NyxHiveConfig {
  return {
    daemon: {
      name: "NyxAI",
      log_level: "info",
      data_dir: "/tmp/nyxhive-test",
      primary_agent: "nyx",
    },
    server: {
      port: 3779,
      api_key: "test-key",
    },
    agents: {
      nyx: {
        name: "Nyx",
        provider: "openrouter",
        model: "openai/gpt-5.4",
        working_directory: "/tmp/nyx",
      },
    },
    providers: {
      openrouter: {
        api_key_env: "OPENROUTER_API_KEY",
        model: "openai/gpt-5.4",
      },
    },
    routing: {
      classifier_model: "openai/gpt-5.4-mini",
      classifier_provider: "openrouter",
      cli_escalation_tasks: [],
    },
    context: {
      max_history: 20,
      summary_threshold: 40,
    },
  } as NyxHiveConfig;
}

function authedApp(config: NyxHiveConfig): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  app.use("*", async (c, next) => {
    c.set("auth", { type: "api_key", role: "owner" });
    await next();
  });
  app.route("/api/config", configRoutes(config));
  return app;
}

describe("configRoutes", () => {
  test("exposes an authenticated workspace config endpoint for capability probes", async () => {
    const response = await authedApp(baseConfig()).request("/api/config");
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(payload.readonly).toBe(true);
    expect(payload.provider).toBe("openrouter");
    expect(payload.model).toBe("openai/gpt-5.4");
    expect(payload.config.server.has_api_key).toBe(true);
    expect(JSON.stringify(payload)).not.toContain("test-key");
  });
});
