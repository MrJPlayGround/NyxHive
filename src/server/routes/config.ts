import { Hono } from "hono";
import type { NyxHiveConfig } from "../../types.js";
import { adminOnly } from "../middleware/rbac.js";

type JsonObject = Record<string, unknown>;

function sanitizedProvider(provider: NyxHiveConfig["providers"][string]): JsonObject {
  return {
    configured: !!provider.api_key_env || !!provider.auth_mode,
    has_api_key_env: !!provider.api_key_env,
    auth_mode: provider.auth_mode,
    runtime: provider.runtime,
    fallback: provider.fallback,
    default_model: provider.default_model,
    url: provider.url,
    model: provider.model,
  };
}

function primaryAgent(config: NyxHiveConfig) {
  const primaryKey = config.daemon.primary_agent ?? Object.keys(config.agents)[0];
  return primaryKey ? config.agents[primaryKey] : undefined;
}

function primaryProvider(config: NyxHiveConfig): string {
  const agent = primaryAgent(config);
  return (
    agent?.provider ??
    config.routing.classifier_provider ??
    Object.keys(config.providers)[0] ??
    ""
  );
}

function primaryModel(config: NyxHiveConfig, provider: string): string {
  const agent = primaryAgent(config);
  return (
    agent?.model ??
    config.providers[provider]?.model ??
    config.providers[provider]?.default_model ??
    config.routing.classifier_model ??
    ""
  );
}

function sanitizeConfig(config: NyxHiveConfig): JsonObject {
  return {
    daemon: {
      name: config.daemon.name,
      log_level: config.daemon.log_level,
      data_dir: config.daemon.data_dir,
      primary_agent: config.daemon.primary_agent,
      main_brain: config.daemon.main_brain,
      workflow_mode: config.daemon.workflow_mode,
      projects: config.daemon.projects,
    },
    server: {
      port: config.server.port,
      public_url: config.server.public_url,
      allowed_origins: config.server.allowed_origins,
      require_auth: config.server.require_auth,
      rate_limit_rpm: config.server.rate_limit_rpm,
      request_timeout_ms: config.server.request_timeout_ms,
      has_api_key: !!config.server.api_key,
      has_api_key_env: !!config.server.api_key_env,
    },
    agents: Object.fromEntries(
      Object.entries(config.agents).map(([key, agent]) => [
        key,
        {
          name: agent.name,
          role: agent.role,
          provider: agent.provider,
          model: agent.model,
          min_model: agent.min_model,
          max_model: agent.max_model,
          working_directory: agent.working_directory,
          capabilities: agent.capabilities,
          sandbox: agent.sandbox,
          toolset: agent.toolset,
          agentic_mode: agent.agentic_mode,
          context_strategy: agent.context_strategy,
          timeout_ms: agent.timeout_ms,
          max_tool_turns: agent.max_tool_turns,
          effort: agent.effort,
          skills: agent.skills,
        },
      ]),
    ),
    teams: config.teams ?? {},
    providers: Object.fromEntries(
      Object.entries(config.providers).map(([key, provider]) => [
        key,
        sanitizedProvider(provider),
      ]),
    ),
    routing: config.routing,
    context: config.context,
    budget: config.budget,
    memory: config.memory,
    models: config.models,
    scheduler: config.scheduler
      ? {
          enabled: config.scheduler.enabled !== false,
          tasks: config.scheduler.tasks?.map((task) => ({
            name: task.name,
            description: task.description,
            cron: task.cron,
            run_at: task.run_at,
            agent: task.agent,
            channel: task.channel,
            notify_channels: task.notify_channels,
            category: task.category,
          })),
        }
      : undefined,
    sandbox: config.sandbox,
    vault: config.vault ? { path: config.vault.path } : undefined,
  };
}

export function configRoutes(config: NyxHiveConfig): Hono {
  const app = new Hono();

  app.get("/", adminOnly, (c) => {
    const provider = primaryProvider(config);
    const model = primaryModel(config, provider);

    return c.json({
      ok: true,
      readonly: true,
      provider,
      model,
      config: sanitizeConfig(config),
    });
  });

  app.patch("/", adminOnly, (c) =>
    c.json(
      {
        ok: false,
        readonly: true,
        error:
          "NyxHive config is file-driven. Edit config.toml and restart to apply changes.",
      },
      405,
    ),
  );

  return app;
}
