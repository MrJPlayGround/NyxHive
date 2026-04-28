import type { NyxTemplate } from "./types.js";
import TOML from "@iarna/toml";
import { DEFAULT_LOCAL_CLASSIFIER_MODEL, DEFAULT_OLLAMA_URL } from "../defaults.js";
import { resolveInstanceVaultPath } from "../utils/obsidian-paths.js";

interface ProjectOverride {
  name: string;
  repo_path: string;
  default?: boolean;
}

export interface InitOverrides {
  instanceName: string;
  port: number;
  providers: Record<string, { api_key_env: string }>;
  sandbox: string;
  authEnabled: boolean;
  vaultPath?: string;
  projects?: ProjectOverride[];
}

export function buildConfigFromTemplate(
  template: NyxTemplate,
  overrides: InitOverrides,
): Record<string, unknown> {
  const config: Record<string, unknown> = {};

  // Daemon
  config.daemon = {
    name: overrides.instanceName,
    log_level: "info",
    data_dir: "./data",
    ...(overrides.projects?.length ? { projects: overrides.projects } : {}),
  };

  // Server
  config.server = {
    port: overrides.port,
  };

  // Agents
  const agents: Record<string, unknown> = {};
  for (const agent of template.config.agents) {
    agents[agent.key] = {
      name: agent.name,
      role: agent.role,
      provider: agent.provider,
      model: agent.model,
      working_directory: "./workspace",
      system_prompt: agent.system_prompt,
      ...(agent.always_cli && { always_cli: true }),
      ...(agent.agentic_mode && { agentic_mode: agent.agentic_mode }),
      ...(agent.min_model && { min_model: agent.min_model }),
      ...(agent.capabilities && { capabilities: agent.capabilities }),
    };
  }
  config.agents = agents;

  // Providers (only those used by template agents)
  const usedProviders = new Set(template.config.agents.map(a => a.provider));
  if (template.config.routing) {
    for (const r of Object.values(template.config.routing)) {
      usedProviders.add(r.provider);
    }
  }
  const providers: Record<string, unknown> = {};
  for (const name of usedProviders) {
    if (overrides.providers[name]) {
      providers[name] = { api_key_env: overrides.providers[name].api_key_env };
    }
  }
  providers.ollama = {
    url: DEFAULT_OLLAMA_URL,
    model: DEFAULT_LOCAL_CLASSIFIER_MODEL,
  };
  config.providers = providers;

  // Routing
  const leadAgent = template.config.agents.find(a => a.role === "lead" || a.role === "orchestrator");

  config.routing = {
    classifier_model: DEFAULT_LOCAL_CLASSIFIER_MODEL,
    classifier_provider: "ollama",
    cli_escalation_tasks: ["coding", "code_review"],
    ...(template.config.routing && { overrides: template.config.routing }),
  };

  // Context
  config.context = {
    max_history: 10,
    summary_threshold: 12,
    summary_max_tokens: 1500,
  };

  // Budget
  if (template.config.budget) {
    config.budget = {
      monthly_limit: template.config.budget.monthly_limit,
      warning_threshold: template.config.budget.warning_threshold,
    };
  }

  // Vault (knowledge)
  const vaultPath = overrides.vaultPath ?? template.knowledge?.vault_path;
  if (vaultPath) {
    const resolvedVaultPath = resolveInstanceVaultPath(overrides.instanceName, vaultPath);
    config.vault = { path: resolvedVaultPath };
    const allowedDirectories = new Set<string>([
      ...(overrides.projects?.map((project) => project.repo_path) ?? []),
      resolvedVaultPath,
    ]);
    config.allowed_directories = [...allowedDirectories];
  }

  // Sandbox
  config.sandbox = { backend: overrides.sandbox };

  // Auth
  if (overrides.authEnabled) {
    config.auth = {
      enabled: true,
      session_ttl_days: 30,
      max_sessions_per_user: 5,
      require_invite: true,
    };
  }

  // Scheduler
  if (template.config.scheduler?.length) {
    const schedulerAgent = leadAgent?.key ?? template.config.agents[0].key;
    config.scheduler = {
      enabled: true,
      tasks: template.config.scheduler.map(s => ({
        name: s.name,
        cron: s.schedule,
        agent: schedulerAgent,
        prompt: s.task,
        channel: "api",
      })),
    };
  }

  return config;
}

export function configToToml(config: Record<string, unknown>): string {
  // JSON roundtrip strips @iarna/toml Symbol metadata
  const clean = JSON.parse(JSON.stringify(config));
  return TOML.stringify(clean);
}
