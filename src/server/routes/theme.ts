import { Hono } from "hono";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { NyxHiveConfig } from "../../types.js";
import { canRead } from "../middleware/rbac.js";

export function themeRoutes(config: NyxHiveConfig): Hono {
  const app = new Hono();

  // GET /api/theme — returns theme config for iOS app
  app.get("/", canRead, (c) => {
    // Look for theme.json in the config directory (sibling to data_dir)
    const dataDir = config.daemon.data_dir;
    const configDir = join(dataDir, "..", "config");
    const themePath = join(configDir, "theme.json");

    if (existsSync(themePath)) {
      try {
        const theme = JSON.parse(readFileSync(themePath, "utf-8"));
        return c.json(theme);
      } catch {
        // Fall through to defaults
      }
    }

    // Default theme (matches current iOS defaults)
    return c.json({
      accentColor: "#00E676",
      appearanceMode: "system",
      appName: config.daemon.name,
      tagline: `Your ${config.daemon.name} assistant`,
      tabs: { chat: true, agents: true, dashboard: true, settings: true },
      chatPlaceholder: "Message...",
      emptyStateMessage: "Hi! How can I help?",
    });
  });

  return app;
}
