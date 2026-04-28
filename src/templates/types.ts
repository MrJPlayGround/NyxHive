import { z } from "zod";

const TemplateCategorySchema = z.enum([
  "productivity",
  "development",
  "business",
  "support",
  "engineering",
  "custom",
]);

const AgentPresetSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_-]*$/),
  name: z.string().min(1).max(50),
  role: z.enum(["orchestrator", "lead", "coder", "reviewer", "expert", "worker", "heartbeat"]),
  provider: z.string(),
  model: z.string(),
  system_prompt: z.string().min(10),
  always_cli: z.boolean().optional(),
  agentic_mode: z.enum(["standard", "strict"]).optional(),
  capabilities: z.array(z.string()).optional(),
  min_model: z.string().optional(),
});

const ThemePresetSchema = z.object({
  accentColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
  appearanceMode: z.enum(["dark", "light", "system"]).default("system"),
  appName: z.string().min(1).max(30),
  tagline: z.string().max(100),
  icon: z.string().optional(),
  tabs: z.object({
    chat: z.literal(true),
    agents: z.boolean().default(true),
    dashboard: z.boolean().default(true),
    settings: z.literal(true),
  }),
  chatPlaceholder: z.string().default("Message..."),
  emptyStateMessage: z.string().default("Hi! How can I help?"),
});

const VaultSkeletonSchema = z.object({
  folders: z.array(z.string()).optional(),
  index_tags: z.array(z.string()).optional(),
  readme_sections: z.array(z.object({
    title: z.string(),
    description: z.string(),
  })).optional(),
}).optional();

const KnowledgePresetSchema = z.object({
  vault_path: z.string(),
  categories: z.array(z.string()),
  description: z.string(),
  exclude: z.array(z.string()).optional(),
  vault_skeleton: VaultSkeletonSchema,
});

const SchedulerPresetSchema = z.object({
  name: z.string(),
  schedule: z.string(),
  task: z.string(),
  model: z.string().optional(),
});

const NyxTemplateSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  name: z.string().min(1).max(60),
  description: z.string().max(200),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  author: z.string(),
  category: TemplateCategorySchema,

  config: z.object({
    agents: z.array(AgentPresetSchema).min(1),
    routing: z.record(z.string(), z.object({
      provider: z.string(),
      model: z.string(),
    })).optional(),
    budget: z.object({
      monthly_limit: z.number().positive(),
      warning_threshold: z.number().min(0).max(1).default(0.8),
    }).optional(),
    scheduler: z.array(SchedulerPresetSchema).optional(),
  }),

  theme: ThemePresetSchema,

  knowledge: KnowledgePresetSchema.optional(),
});

export type NyxTemplate = z.infer<typeof NyxTemplateSchema>;
export type AgentPreset = z.infer<typeof AgentPresetSchema>;
export type ThemePreset = z.infer<typeof ThemePresetSchema>;
export type KnowledgePreset = z.infer<typeof KnowledgePresetSchema>;

export {
  NyxTemplateSchema,
  AgentPresetSchema,
  ThemePresetSchema,
  KnowledgePresetSchema,
  TemplateCategorySchema,
  SchedulerPresetSchema,
};
