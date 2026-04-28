import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { buildCapabilitySnapshot } from "../capabilities/snapshot.js";
import { classifyProviderFileOmission } from "../providers/file-blockers.js";
import { ProviderRouter } from "../providers/router.js";
import type { AuthEnv } from "../auth/types.js";
import type { Channel } from "../channels/types.js";
import type { NyxHiveConfig } from "../types.js";
import type { Provider } from "../providers/types.js";
import { statusRoutes } from "../server/routes/status.js";

function withAuth(routes: Hono, basePath: string): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  app.use("/*", async (c, next) => {
    c.set("auth" as never, { type: "api_key", role: "owner" } as never);
    return next();
  });
  app.route(basePath, routes);
  return app;
}

const TEST_CONFIG: NyxHiveConfig = {
  daemon: { name: "test", log_level: "error", data_dir: "/tmp" },
  server: { port: 3000 },
  agents: {
    nyx: {
      name: "Nyx",
      role: "lead",
      provider: "openai",
      model: "gpt-5.4",
      working_directory: "/repo",
      always_cli: true,
      cli_fallback: "codex",
    },
  },
  teams: {},
  providers: {
    openai: { api_key_env: "OPENAI_API_KEY" },
    anthropic: { api_key_env: "ANTHROPIC_API_KEY" },
    openrouter: { api_key_env: "OPENROUTER_API_KEY" },
  },
  discord: { bot_token_env: "DISCORD_BOT_TOKEN" },
  routing: { classifier_model: "gpt-5-mini", classifier_provider: "openai", cli_escalation_tasks: [] },
  context: { max_history: 10, summary_threshold: 5 },
};

function makeProvider(name: string, models: string[]): Provider {
  return {
    name,
    listModels: () => models,
    complete: async () => ({
      content: "ok",
      model: models[0] ?? "model",
      provider: name,
      tokensIn: 0,
      tokensOut: 0,
    }),
  } as Provider;
}

function makeChannel(name: string, connected: boolean, outbound = false): Channel {
  return {
    name,
    start: async () => {},
    stop: async () => {},
    isConnected: () => connected,
    getStats: () => ({ messagesReceived: 0, messagesSent: 0, errors: 0 }),
    ...(outbound ? { sendOutbound: async () => {} } : {}),
  };
}

describe("capability snapshot v0", () => {
  test("builds attachment, provider, channel, media, and handoff primitives from runtime/config evidence", () => {
    const router = new ProviderRouter({
      orchestrator_model: "gpt-5.4",
      orchestrator_provider: "openai",
      classifier_model: "gpt-5-mini",
      classifier_provider: "openai",
      coding_model: "gpt-5.4",
      coding_provider: "openai",
    } as any);
    router.registerProvider("openai", makeProvider("openai", ["gpt-5.4", "gpt-5-mini"]));

    const snapshot = buildCapabilitySnapshot({
      config: TEST_CONFIG,
      providerRouter: router,
      channels: [makeChannel("discord", true, true)],
      queueAvailable: true,
      blockedPathReportsAvailable: true,
      artifactStoreAvailable: true,
    });

    expect(snapshot.version).toBe("capability_snapshot.v0");
    expect(snapshot.sources).toEqual(expect.arrayContaining([
      "config.providers",
      "provider_router.registered_providers",
      "providers.types.supported_file_types",
      "channels.runtime",
    ]));

    expect(snapshot.primitives["attachments.ingest"]).toMatchObject({
      status: "supported",
      max_files: 5,
      max_bytes: 10 * 1024 * 1024,
    });
    expect(snapshot.primitives["attachments.ingest"].mime_types).toEqual(expect.arrayContaining([
      "audio/mpeg",
      "application/pdf",
      "image/png",
      "text/plain",
    ]));

    expect(snapshot.providers.find((provider) => provider.name === "openai")).toMatchObject({
      configured: true,
      registered: true,
      models: ["gpt-5.4", "gpt-5-mini"],
      file_support: {
        image: { status: "supported" },
        text: { status: "supported" },
        audio: { status: "missing", missing_primitive: "provider.file.audio_content_block" },
        pdf: { status: "missing", missing_primitive: "provider.file.pdf_content_block" },
      },
    });
    expect(snapshot.providers.find((provider) => provider.name === "anthropic")).toMatchObject({
      configured: true,
      registered: false,
      status: "missing",
      missing_primitive: "provider.anthropic.runtime_registration",
    });

    expect(snapshot.channels.find((channel) => channel.name === "discord")).toMatchObject({
      configured: true,
      connected: true,
      supports_outbound: true,
      attachment_ingest: { status: "supported" },
    });
    expect(snapshot.primitives["media.transcription"]).toMatchObject({
      status: "missing",
      missing_primitive: "media.transcription.handler",
    });
    expect(snapshot.primitives["handoff.async_queue"]).toMatchObject({ status: "supported" });
    expect(snapshot.primitives["blocked_path.reports"]).toMatchObject({ status: "supported" });
    expect(snapshot.primitives["artifacts.inbound"]).toMatchObject({ status: "supported" });
    expect(snapshot.missing_primitives).toEqual(expect.arrayContaining([
      "provider.anthropic.runtime_registration",
      "provider.file.audio_content_block",
      "media.transcription.handler",
    ]));
  });

  test("keeps provider blocker missing primitives aligned with provider file support truth", () => {
    const blocker = classifyProviderFileOmission("sdk", "openai", {
      name: "clip.mp3",
      mimeType: "audio/mpeg",
      base64: "aGVsbG8=",
      size: 5,
    });
    const snapshot = buildCapabilitySnapshot({ config: TEST_CONFIG });
    const openai = snapshot.providers.find((provider) => provider.name === "openai");

    expect(blocker?.missingPrimitive).toBe("provider.file.audio_content_block");
    expect(openai?.file_support.audio).toMatchObject({
      status: "missing",
      missing_primitive: blocker?.missingPrimitive,
    });
  });

  test("GET /api/status/capabilities exposes the same snapshot without requiring a dashboard", async () => {
    const processor = {
      getActiveDelegations: () => new Map(),
      getChannels: () => [makeChannel("discord", true, true)],
    };
    const app = withAuth(
      statusRoutes(processor as any, undefined, TEST_CONFIG, {
        config: TEST_CONFIG,
        startTime: Date.now(),
        providerRouter: undefined,
        queue: { getQueueHealth: () => ({ stats: { pending: 0, processing: 0 } }) } as any,
        runs: { getStaleRunningCount: () => 0 } as any,
      }),
      "/api/status",
    );

    const res = await app.request("/api/status/capabilities");
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.version).toBe("capability_snapshot.v0");
    expect(body.channels.find((channel: any) => channel.name === "discord")).toMatchObject({
      connected: true,
      attachment_ingest: { status: "supported" },
    });
    expect(body.primitives["blocked_path.reports"]).toMatchObject({ status: "supported" });
    expect(body.primitives["artifacts.inbound"]).toMatchObject({ status: "supported" });
  });
});
