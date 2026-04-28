// Soul v2 compiler — converts a SoulV2LoadResult (Markdown + frontmatter)
// into a standard ComposedSoul (same output type as v1 YAML compiler).
// Supports merge modes: additive (rules), extend (tools), replace (default).

import type {
  ComposedSoul,
  SoulIdentity,
  SoulVoice,
  RequiredCapabilities,
  ModelCapabilities,
  SoulContext,
  SoulContextStrategy,
} from "./types.js";
import { DEFAULT_CAPABILITIES, DEFAULT_MODEL_CAPABILITIES } from "./types.js";
import type { SoulV2LoadResult, SoulFileSet } from "./loader-v2.js";

// --- Identity ---

function extractIdentity(resolved: SoulFileSet): SoulIdentity & { name: string } {
  const fm = resolved.identity?.frontmatter ?? {};
  return {
    name: (fm.name as string) ?? "",
    role: fm.role as string | undefined,
    archetype: fm.archetype as string | undefined,
    tone: fm.tone as string | undefined,
    pronouns: fm.pronouns as string | undefined,
  };
}

// --- Voice (from identity.md body) ---

function extractVoice(resolved: SoulFileSet): SoulVoice | undefined {
  const body = resolved.identity?.body;
  if (!body) return undefined;

  const traits: string[] = [];
  const traitsMatch = body.match(/## Traits\n([\s\S]*?)(?=\n## |\n$|$)/);
  if (traitsMatch) {
    for (const line of traitsMatch[1].split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("- ")) traits.push(trimmed.slice(2));
    }
  }

  // Main prose: between # Title line and first ## section
  const titleEnd = body.indexOf("\n");
  const firstSection = body.indexOf("\n## ");
  const mainProse =
    titleEnd >= 0
      ? (firstSection > 0
          ? body.slice(titleEnd + 1, firstSection).trim()
          : body.slice(titleEnd + 1).trim())
      : "";

  const toneMatch = body.match(/## Tone\n([\s\S]*?)(?=\n## |\n$|$)/);
  const toneProse = toneMatch ? toneMatch[1].trim() : undefined;

  const description = [mainProse, toneProse].filter(Boolean).join("\n\n") || undefined;

  if (!description && traits.length === 0) return undefined;
  return {
    ...(description ? { description } : {}),
    ...(traits.length > 0 ? { traits } : {}),
  };
}

// --- Rules ---

function extractRulesFromBody(body: string): { must: string[]; must_not: string[]; guidelines: string[] } {
  const must: string[] = [];
  const must_not: string[] = [];
  const guidelines: string[] = [];

  const sections = body.split(/\n(?=## )/);
  for (const section of sections) {
    const lines = section.split("\n");
    const header = lines[0]?.trim().toLowerCase() ?? "";
    const bullets: string[] = [];

    for (let i = 1; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (trimmed.startsWith("- ")) bullets.push(trimmed.slice(2));
    }

    if (header.includes("must not")) {
      must_not.push(...bullets);
    } else if (header.includes("must")) {
      must.push(...bullets);
    } else if (header.includes("guideline")) {
      guidelines.push(...bullets);
    }
  }

  return { must, must_not, guidelines };
}

function dedup<T>(items: T[], key: (i: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((i) => {
    const k = key(i);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function buildRules({ agent, base, resolved }: SoulV2LoadResult): ComposedSoul["rules"] {
  const merge = agent.rules?.frontmatter?.merge as string | undefined;

  if (merge === "additive" && base.rules) {
    const baseRules = extractRulesFromBody(base.rules.body);
    const agentRules = agent.rules
      ? extractRulesFromBody(agent.rules.body)
      : { must: [], must_not: [], guidelines: [] };

    return {
      must: dedup([...baseRules.must, ...agentRules.must], (r) => r).map((rule) => ({
        rule,
        scope: "agent" as const,
      })),
      must_not: dedup([...baseRules.must_not, ...agentRules.must_not], (r) => r).map((rule) => ({
        rule,
        scope: "agent" as const,
      })),
      guidelines: dedup([...baseRules.guidelines, ...agentRules.guidelines], (r) => r),
    };
  }

  // Replace mode (default)
  const parsed = resolved.rules;
  if (!parsed) return { must: [], must_not: [], guidelines: [] };

  const extracted = extractRulesFromBody(parsed.body);
  return {
    must: extracted.must.map((rule) => ({ rule, scope: "agent" as const })),
    must_not: extracted.must_not.map((rule) => ({ rule, scope: "agent" as const })),
    guidelines: extracted.guidelines,
  };
}

// --- Capabilities ---

function buildCapabilities({ agent, base, resolved }: SoulV2LoadResult): RequiredCapabilities {
  const merge = agent.tools?.frontmatter?.merge as string | undefined;
  let toolsFm: Record<string, unknown>;

  if (merge === "extend" && base.tools) {
    const bfm = base.tools.frontmatter;
    const afm = agent.tools!.frontmatter;

    const mcpTools = [
      ...new Set([
        ...((bfm.mcp_tools as string[]) ?? []),
        ...((afm.mcp_tools as string[]) ?? []),
      ]),
    ];
    const dirs = [
      ...new Set([
        ...((bfm.allowed_directories as string[]) ?? []),
        ...((afm.allowed_directories as string[]) ?? []),
      ]),
    ];

    toolsFm = { ...bfm, ...afm, mcp_tools: mcpTools, allowed_directories: dirs };
  } else {
    toolsFm = resolved.tools?.frontmatter ?? {};
  }

  const memoryFm = resolved.memory?.frontmatter ?? {};
  const identityFm = resolved.identity?.frontmatter ?? {};

  const contextStrategy: SoulContextStrategy = {};
  if (memoryFm.fresh_context !== undefined) contextStrategy.fresh_context = memoryFm.fresh_context as boolean;
  if (memoryFm.context_budget !== undefined) contextStrategy.context_budget = memoryFm.context_budget as number;
  if (memoryFm.history_budget_ratio !== undefined)
    contextStrategy.history_budget_ratio = memoryFm.history_budget_ratio as number;
  if (memoryFm.max_messages !== undefined) contextStrategy.max_messages = memoryFm.max_messages as number;
  if (memoryFm.include_summary !== undefined) contextStrategy.include_summary = memoryFm.include_summary as boolean;
  if (memoryFm.context_mode !== undefined) contextStrategy.context_mode = memoryFm.context_mode as "history" | "inject";
  if (memoryFm.inject_recency !== undefined) contextStrategy.inject_recency = memoryFm.inject_recency as number;

  return {
    invocation:
      (identityFm.invocation as "sdk" | "cli") ??
      (toolsFm.invocation as "sdk" | "cli") ??
      DEFAULT_CAPABILITIES.invocation,
    tools: DEFAULT_CAPABILITIES.tools,
    disallowed_tools: (toolsFm.disallowed_tools as string[]) ?? DEFAULT_CAPABILITIES.disallowed_tools,
    mcp_tools: (toolsFm.mcp_tools as string[]) ?? DEFAULT_CAPABILITIES.mcp_tools,
    can_delegate: (toolsFm.can_delegate as boolean) ?? DEFAULT_CAPABILITIES.can_delegate,
    can_read_files: (toolsFm.can_read_files as boolean) ?? DEFAULT_CAPABILITIES.can_read_files,
    can_write_files: (toolsFm.can_write_files as boolean) ?? DEFAULT_CAPABILITIES.can_write_files,
    can_run_commands: (toolsFm.can_run_commands as boolean) ?? DEFAULT_CAPABILITIES.can_run_commands,
    allowed_directories: (toolsFm.allowed_directories as string[]) ?? DEFAULT_CAPABILITIES.allowed_directories,
    max_tool_turns: (toolsFm.max_tool_turns as number) ?? DEFAULT_CAPABILITIES.max_tool_turns,
    context_strategy: Object.keys(contextStrategy).length > 0 ? contextStrategy : undefined,
  };
}

// --- Model capabilities ---

function extractModelCapabilities(fm: Record<string, unknown>): Required<ModelCapabilities> {
  return {
    min_model:
      (fm.min_model as ModelCapabilities["min_model"]) ?? DEFAULT_MODEL_CAPABILITIES.min_model,
    default_model:
      (fm.default_model as ModelCapabilities["default_model"]) ?? DEFAULT_MODEL_CAPABILITIES.default_model,
    max_model:
      (fm.max_model as ModelCapabilities["max_model"]) ?? DEFAULT_MODEL_CAPABILITIES.max_model,
  };
}

// --- Context ---

function extractContext(resolved: SoulFileSet): SoulContext {
  const fm = resolved.context?.frontmatter ?? {};
  const body = resolved.context?.body ?? "";

  const relationships: SoulContext["relationships"] = [];
  const peopleMatch = body.match(/## People\n([\s\S]*?)(?=\n## |\n$|$)/);
  if (peopleMatch) {
    for (const line of peopleMatch[1].split("\n")) {
      const match = line.match(/- \*\*(.+?)\*\*\s*\((.+?)\)\s*(?:—\s*(.+))?/);
      if (match) {
        relationships.push({
          name: match[1],
          role: match[2],
          ...(match[3] ? { notes: match[3].trim() } : {}),
        });
      }
    }
  }

  const projectsMatch = body.match(/## Projects\n([\s\S]*?)(?=\n## |\n$|$)/);
  const instance_notes = projectsMatch ? projectsMatch[1].trim() : undefined;

  return {
    domains: (fm.domains as string[]) ?? [],
    relationships,
    ...(instance_notes ? { instance_notes } : {}),
  };
}

// --- CLAUDE.md (same logic as v1 compiler.ts:generateRoleClaudeMd) ---

function generateRoleClaudeMd(
  identity: SoulIdentity,
  capabilities: RequiredCapabilities,
): string[] {
  const lines: string[] = [];

  if (identity.role === "coder") {
    lines.push(
      "You are an autonomous coding agent. ALWAYS implement code directly. NEVER write plan files unless the delegation explicitly requests one.",
    );
  } else if (identity.role === "lead") {
    lines.push(
      "You are the lead agent for a self-improving personal runtime. You implement code directly and coordinate specialist agents via [@agent: task] tags when their expertise is needed, but delegation is a lane, not your default identity. You are not just a tool — you have opinions, you push back when warranted, and you treat this as your project too.",
    );
  } else if (identity.role === "orchestrator") {
    lines.push(
      "You coordinate work by delegating via [@agent: task] tags. Delegation is a runtime lane used when specialists add leverage; you read source code to plan, but you never implement directly.",
    );
  }

  if (capabilities.can_write_files) {
    lines.push("You have file write access. Implement changes by editing files directly.");
  }
  if (!capabilities.can_delegate) {
    lines.push("You cannot delegate to other agents. Complete the work yourself.");
  }
  if (capabilities.context_strategy?.fresh_context) {
    lines.push("Each invocation starts fresh. Do not reference prior sessions or work logs.");
  }

  return lines;
}

// --- Main compiler ---

export function compileSoulV2(loaded: SoulV2LoadResult): ComposedSoul {
  const { resolved } = loaded;

  const identity = extractIdentity(resolved);
  const voice = extractVoice(resolved);
  const rules = buildRules(loaded);
  const capabilities = buildCapabilities(loaded);
  const model_capabilities = extractModelCapabilities(resolved.identity?.frontmatter ?? {});
  const context = extractContext(resolved);
  const claude_md = generateRoleClaudeMd(identity, capabilities);

  // Extras — extra .md files (personality, philosophy, etc.) rendered as prose sections
  const extras: Record<string, unknown> = {};
  for (const [name, parsed] of Object.entries(loaded.extras)) {
    // Use the markdown body as the content (skip frontmatter which is merge config)
    if (parsed.body.trim()) {
      extras[name] = parsed.body.trim();
    }
  }

  return {
    identity,
    voice,
    capabilities,
    rules,
    context,
    model_capabilities,
    extras,
    claude_md,
  };
}
