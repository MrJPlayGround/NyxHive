import { Hono } from "hono";
import type { NyxHiveConfig } from "../../types.js";
import { adminOnly, canRead } from "../middleware/rbac.js";

/**
 * Expose a sanitized, read-only view of the NyxHive config.
 * Strips API keys and sensitive env var names.
 */
function sanitize(config: NyxHiveConfig): Record<string, unknown> {
  return {
    workspace: {
      name: config.daemon.name,
      path: config.daemon.data_dir,
      log_level: config.daemon.log_level,
    },
    server: {
      port: config.server.port,
      has_api_key: !!config.server.api_key,
    },
    agents: Object.fromEntries(
      Object.entries(config.agents).map(([id, a]) => [id, {
        name: a.name,
        provider: a.provider,
        model: a.model,
        working_directory: a.working_directory,
        capabilities: a.capabilities,
        sandbox: a.sandbox,
      }]),
    ),
    teams: config.teams
      ? Object.fromEntries(
          Object.entries(config.teams).map(([id, t]) => [id, {
            name: t.name,
            agents: t.agents,
            description: t.description,
          }]),
        )
      : {},
    channels: {
      enabled: [
        config.telegram ? "telegram" : null,
        config.discord ? "discord" : null,
        config.slack ? "slack" : null,
        config.imessage ? "imessage" : null,
      ].filter(Boolean),
    },
    models: {
      provider: Object.keys(config.providers)[0] ?? "unknown",
      providers: Object.keys(config.providers),
    },
    routing: {
      classifier_model: config.routing.classifier_model,
      classifier_provider: config.routing.classifier_provider,
    },
    context: config.context,
    monitoring: {
      heartbeat_interval: 30,
    },
    scheduler: config.scheduler ? {
      enabled: config.scheduler.enabled !== false,
      task_count: config.scheduler.tasks?.length ?? 0,
    } : null,
    sandbox: config.sandbox,
    vault: config.vault ? { path: config.vault.path } : null,
  };
}

export function settingsRoutes(config: NyxHiveConfig): Hono {
  const app = new Hono();

  // GET /api/settings — read-only sanitized config
  app.get("/", canRead, (c) => {
    return c.json(sanitize(config));
  });

  // PUT /api/settings — not supported (config is file-driven)
  app.put("/", adminOnly, (c) => {
    // Return the current settings but indicate it's read-only
    return c.json({
      ok: true,
      readonly: true,
      message: "Config is driven by nyxhive.toml. Edit the file directly and restart.",
      settings: sanitize(config),
    });
  });

  return app;
}
