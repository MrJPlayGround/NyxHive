import { z } from "zod";

const schedulerTaskProfiles = ["full", "dev", "trading", "monitor", "none"] as const;
const builtinPresetNames = ["coder", "companion", "ops", "researcher", "custom"] as const;
const providerNames = ["anthropic", "openai", "openrouter", "ollama"] as const;

/** Accepts a single {channel, recipient} or an array of them. */
const singleTarget = z.object({ channel: z.string(), recipient: z.string() });
const notificationTargetSchema = z.union([singleTarget, z.array(singleTarget)]);
export const presetReferenceSchema = z.string().regex(
  /^(?:preset:)?[a-z][a-z0-9_-]*$/,
  "Preset references must look like 'coder' or 'preset:coder'",
);

const agentSchema = z.object({
  name: z.string(),
  role: z.enum(["orchestrator", "lead", "coder", "reviewer", "expert", "worker", "heartbeat"]).optional(),
  provider: z.string(),
  model: z.string(),
  min_model: z.string().optional(),
  max_model: z.string().optional(),
  companion_mode: z.boolean().optional(),
  agentic_mode: z.enum(["standard", "strict"]).optional(),
  always_cli: z.boolean().optional(),
  cli_fallback: z.enum(["claude", "codex"]).optional(),
  working_directory: z.string(),
  system_prompt: z.string().optional(),
  soul: z.string().optional(),  // Agent key, path to soul YAML, or preset reference
  capabilities: z.array(z.string()).optional(),
  sandbox: z.enum(["docker", "macos", "none"]).optional(),
  allowed_directories: z.array(z.string()).optional(),
  allowed_tools: z.array(z.string()).optional(),
  disallowed_tools: z.array(z.string()).optional(),
  mcp_tools: z.array(z.string()).optional(),
  timeout_ms: z.number().int().positive().optional(),
  approved_commands: z.array(z.string()).optional(),
  credentials: z.array(z.string()).optional(),
  max_tool_turns: z.number().int().positive().optional(),
  effort: z.enum(["low", "medium", "high", "max"]).optional(),
  identity: z.object({
    slack_username: z.string().optional(),
    slack_emoji: z.string().optional(),
    slack_icon_url: z.string().optional(),
    ack_reaction: z.string().optional(),
    done_reaction: z.string().optional(),
    error_reaction: z.string().optional(),
    typing_reaction: z.string().optional(),
  }).optional(),
  context_strategy: z.object({
    history_budget_ratio: z.number().min(0).max(1).optional(),
    max_messages: z.number().int().positive().optional(),
    include_summary: z.boolean().optional(),
    strip_code_blocks: z.boolean().optional(),
    fresh_context: z.boolean().optional(),
    context_mode: z.enum(["history", "inject"]).optional(),
    inject_recency: z.number().int().positive().optional(),
  }).optional(),
});

const teamSchema = z.object({
  name: z.string(),
  agents: z.array(z.string()),
  description: z.string().optional(),
});

const providerSchema = z.object({
  api_key_env: z.string().optional(),
  auth_mode: z.enum(["api_key", "codex"]).optional(),
  runtime: z.enum(["cli", "codex_app_server"]).optional(),
  fallback: z.enum(["none", "openrouter"]).optional(),
  default_model: z.string().optional(),
  url: z.string().optional(),
  model: z.string().optional(),
});

export const simpleProviderSchema = z.object({
  name: z.enum(providerNames),
  api_key_env: z.string().optional(),
  auth_mode: z.enum(["api_key", "codex"]).optional(),
  runtime: z.enum(["cli", "codex_app_server"]).optional(),
  fallback: z.enum(["none", "openrouter"]).optional(),
  url: z.string().optional(),
  model: z.string().optional(),
});

const crawlSourceSchema = z.object({
  name: z.string(),
  url: z.string().url(),
  schedule: z.string(),
  depth: z.number().int().positive().optional(),
  page_limit: z.number().int().positive().optional(),
  path_glob: z.string().optional(),
  scope: z.string().default("general"),
  enabled: z.boolean().default(true),
});

export const configSchema = z.object({
  daemon: z.object({
    name: z.string(),
    log_level: z.enum(["debug", "info", "warn", "error"]).default("info"),
    data_dir: z.string().optional(),
    claude_config_dir: z.string().optional(),
    codex_home: z.string().optional(),
    primary_agent: z.string().optional(),
    main_brain: z.string().optional(),
    workflow_mode: z.enum(["direct", "proposal_first"]).default("direct"),
    webhook_url: z.string().url().optional(),
    webhook_secret: z.string().optional(),
    projects: z.array(z.object({
      name: z.string(),
      repo_path: z.string(),
      default: z.boolean().optional(),
      verify: z.object({
        test_command: z.string().optional(),
        build_command: z.string().optional(),
        timeout_ms: z.number().min(5000).default(120_000),
      }).optional(),
    })).optional(),
  }),
  server: z.object({
    port: z.number(),
    api_key: z.string().optional(),
    api_key_env: z.string().optional(),
    public_url: z.string().url().optional(),
    allowed_origins: z.array(z.string()).optional(),
    require_auth: z.boolean().default(true),
    rate_limit_rpm: z.number().optional(),
    request_timeout_ms: z.number().default(120000),
  }),
  agents: z.record(z.string(), agentSchema),
  teams: z.record(z.string(), teamSchema).optional(),
  providers: z.record(z.string(), providerSchema),
  routing: z.object({
    classifier_model: z.string(),
    classifier_provider: z.string(),
    cli_escalation_tasks: z.array(z.string()),
    tasks: z.record(z.string(), z.object({
      provider: z.string(),
      model: z.string(),
      max_tokens: z.number().optional(),
    })).optional(),
    overrides: z.record(z.string(), z.object({
      provider: z.string(),
      model: z.string(),
      max_tokens: z.number().optional(),
    })).optional(),
    fallback_order: z.array(z.string()).optional(),
  }),
  context: z.object({
    max_history: z.number().default(200),
    summary_threshold: z.number().default(20),
    summary_max_tokens: z.number().int().positive().default(1500),
    history_budget_ratio: z.number().min(0.1).max(0.9).default(0.5),
  }),
  budget: z.object({
    monthly_limit: z.number().default(0),
    warning_threshold: z.number().default(0.8),
    daily_limit: z.number().default(0),
    per_conversation_warn: z.number().default(1.00),
  }).optional(),
  memory: z.object({
    extraction_interval: z.number().default(5),
    graph_briefing_max_nodes: z.number().default(20),
    graph_decay_interval_ms: z.number().default(21600000),
    graph_prune_min_importance: z.number().default(0.05),
  }).optional(),
  runtime: z.object({
    mode: z.enum(["legacy", "kernel"]).default("legacy"),
  }).optional(),
  models: z.object({
    cost_rates_file: z.string().optional(),
    tiers_file: z.string().optional(),
  }).optional(),
  telegram: z.object({
    bot_token_env: z.string(),
  }).optional(),
  discord: z.object({
    bot_token_env: z.string(),
    reply_surface: z.enum(["same_surface", "prefer_thread", "thread_only"]).default("same_surface"),
    require_mention: z.boolean().default(false),
    privileged_user_ids: z.array(z.string()).default([]),
    privileged_user_id_env: z.string().optional(),
  }).optional(),
  slack: z.object({
    bot_token_env: z.string(),
    app_token_env: z.string(),
    auto_approve_role: z.enum(["operator", "engineer", "support", "viewer"]).optional(),
    user_roles: z.record(z.string(), z.enum(["operator", "engineer", "support", "viewer"])).optional(),
    channel_agents: z.record(z.string(), z.string()).optional(),
    monitor_channels: z.array(z.string()).optional(),
    auto_thread: z.boolean().default(true),
    interactive_replies: z.boolean().default(false),
    mode: z.enum(["socket", "http"]).default("socket"),
    signing_secret_env: z.string().optional(),
    webhook_path: z.string().default("/slack/events"),
    accounts: z.record(z.string(), z.object({
      bot_token_env: z.string(),
      app_token_env: z.string(),
      channel_agents: z.record(z.string(), z.string()).optional(),
      monitor_channels: z.array(z.string()).optional(),
    })).optional(),
    streaming: z.object({
      enabled: z.boolean().default(false),
      update_interval_ms: z.number().min(250).default(500),
      max_preview_chars: z.number().min(100).default(4000),
    }).default({ enabled: false, update_interval_ms: 500, max_preview_chars: 4000 }),
    channels: z.record(z.string(), z.object({
      agent: z.string().optional(),
      require_mention: z.boolean().optional(),
      system_prompt: z.string().optional(),
      allowed_users: z.array(z.string()).optional(),
      tools: z.array(z.string()).optional(),
      allow_bots: z.boolean().optional(),
      history_limit: z.number().int().positive().optional(),
      dm_history_limit: z.number().int().positive().optional(),
    })).optional(),
    chunk_limit: z.number().int().positive().default(3000),
  }).optional(),
  imessage: z.object({
    db_path: z.string().optional(),
    poll_interval_ms: z.number().min(500).default(2000),
    allowed_numbers: z.array(z.string()).optional(),
  }).optional(),
  webhook: z.object({
    enabled: z.boolean().default(false),
    sources: z.record(z.string(), z.object({
      secret_env: z.string(),
      events: z.array(z.string()),
      agent: z.string().optional(),
      repos: z.array(z.string()).optional(),
    })).optional(),
  }).optional(),
  crawl: z.object({
    enabled: z.boolean().default(false),
    default_depth: z.number().int().positive().default(2),
    default_page_limit: z.number().int().positive().default(50),
    timeout_ms: z.number().int().positive().default(300000),
    sources: z.array(crawlSourceSchema).default([]),
  }).optional(),
  vault: z.object({
    path: z.string(),
    skip_dirs: z.array(z.string()).optional(),
    auto_ingest_interval_hours: z.number().optional(),
    watch: z.boolean().default(true),
    generate_canvas: z.boolean().default(true),
  }).optional(),
  pairing: z.object({
    enabled: z.boolean().default(false),
  }).optional(),
  sandbox: z.object({
    backend: z.enum(["docker", "macos", "none"]).default("none"),
    docker_image: z.string().optional(),
    required: z.boolean().default(false),
  }).optional(),
  queue: z.object({
    response_ttl_days: z.number().default(30),
  }).optional(),
  auth: z.object({
    enabled: z.boolean().default(false),
    session_ttl_days: z.number().default(30),
    max_sessions_per_user: z.number().default(5),
    require_invite: z.boolean().default(true),
  }).optional(),
  scheduler: z.object({
    enabled: z.boolean().default(true),
    automations: z.boolean().default(false),
    seed_defaults: z.boolean().default(false),
    task_profile: z.enum(schedulerTaskProfiles).optional(),
    tick_interval_ms: z.number().min(1000).default(60000),
    idle_discovery_enabled: z.boolean().default(false),
    idle_threshold_minutes: z.number().min(1).default(30),
    idle_cooldown_minutes: z.number().min(1).default(120),
    notify_channels: z.array(z.string()).optional(),
    tasks: z.array(z.object({
      name: z.string(),
      description: z.string().optional(),
      cron: z.string().optional(),
      run_at: z.number().optional(),
      agent: z.string(),
      prompt: z.string(),
      channel: z.string().default("api"),
      recipient: z.string().optional(),
      notify_channels: z.array(z.string()).optional(),
      timeout_ms: z.number().int().positive().optional(),
      authority_profile: z.enum(["scheduled", "system", "interactive"]).optional(),
      category: z.string().default("ops"),
      chain_to: z.object({
        task_name: z.string(),
        inject_result: z.boolean().default(true),
        only_if: z.union([
          z.string(),
          z.array(z.string()),
        ]).default("always"),
      }).optional(),
    })).optional(),
  }).optional(),
  review_gate: z.object({
    enabled: z.boolean().default(true),
    model: z.string().optional(),
    provider: z.string().optional(),
    max_tokens: z.number().int().positive().optional(),
    max_diff_lines: z.number().int().positive().optional(),
    timeout_ms: z.number().int().positive().optional(),
    max_retries: z.number().int().min(0).max(3).default(1),
    roles: z.array(z.string()).optional(),
  }).optional(),
  orchestration: z.object({
    agents_sdk: z.object({
      enabled: z.boolean().default(false),
    }).optional(),
  }).optional(),
  notifications: z.object({
    proposals: notificationTargetSchema.optional(),
    alerts: notificationTargetSchema.optional(),
    reports: notificationTargetSchema.optional(),
    activity: notificationTargetSchema.optional(),
    trades: notificationTargetSchema.optional(),
  }).optional(),
  trading: z.object({
    enabled: z.boolean().default(false),
    timezone: z.string().default("Europe/Lisbon"),
    default_market: z.string().default("crypto"),
    risk_per_trade_percent: z.number().min(0.1).max(10).default(1),
    daily_loss_limit: z.number().positive().default(500),
    max_position_size: z.number().positive().default(5000),
    max_concurrent_positions: z.number().int().positive().default(3),
    max_daily_trades: z.number().int().positive().default(6),
  }).optional(),
  allowed_directories: z.array(z.string()).optional(),
  remotes: z.record(z.string(), z.object({
    url: z.string().url(),
    api_key_env: z.string(),
    description: z.string().optional(),
    agents: z.array(z.string()).optional(),
  })).optional(),
});

export const simpleConfigSchema = z.object({
  name: z.string(),
  port: z.number(),
  preset: z.union([z.enum(builtinPresetNames), presetReferenceSchema]).optional(),
  provider: simpleProviderSchema,
  telegram: z.object({
    bot_token_env: z.string(),
  }).optional(),
  discord: z.object({
    bot_token_env: z.string(),
    reply_surface: z.enum(["same_surface", "prefer_thread", "thread_only"]).default("same_surface"),
    require_mention: z.boolean().default(false),
    privileged_user_ids: z.array(z.string()).default([]),
    privileged_user_id_env: z.string().optional(),
  }).optional(),
  slack: z.object({
    bot_token_env: z.string(),
    app_token_env: z.string(),
  }).optional(),
  imessage: z.object({
    db_path: z.string().optional(),
    poll_interval_ms: z.number().min(500).default(2000),
    allowed_numbers: z.array(z.string()).optional(),
  }).optional(),
  scheduler: z.object({
    enabled: z.boolean().default(true),
    notify_channels: z.array(z.string()).optional(),
  }).optional(),
  pairing: z.object({
    enabled: z.boolean().default(true),
  }).optional(),
  sandbox: z.object({
    backend: z.enum(["docker", "macos", "none"]).default("none"),
  }).optional(),
  vault: z.object({
    path: z.string(),
  }).optional(),
  allowed_directories: z.array(z.string()).optional(),
});
