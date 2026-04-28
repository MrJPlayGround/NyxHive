import { mkdirSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { logger } from "../utils/logger.js";
import type { AgentConfig, NyxHiveConfig } from "../types.js";
import { generateWorkspaceDocs } from "./platform-docs.js";
import type { AgentRegistry } from "./registry.js";
import type { Scheduler } from "../scheduler/index.js";
import type { MemoryStore } from "../memory/store.js";
import { getSoulSystemPrompt } from "../soul/index.js";
import { loadAndCompileSoul } from "../soul/runtime.js";
import { renderClaudeMd } from "../soul/compiler.js";
import { generatePluginJson } from "./skill-loader.js";
import { resolveAgentRuntimePath } from "./paths.js";
import { applyAgenticModePrompt } from "./agentic-mode.js";

/**
 * Set up an agent's working directory with platform documentation.
 * PLATFORM.md and AGENTS.md are regenerated on every boot to stay current.
 * .claude/CLAUDE.md is also regenerated (for Claude CLI agents).
 */
export function ensureWorkspace(
  agent: AgentConfig,
  baseDir: string,
  config?: NyxHiveConfig,
  agentKey?: string,
  registry?: AgentRegistry,
  scheduler?: Scheduler,
  memory?: MemoryStore,
  instanceSoulsDir?: string,
): string {
  const workDir = resolveAgentRuntimePath(baseDir, agent.working_directory) ?? resolve(baseDir);
  mkdirSync(workDir, { recursive: true });

  // AGENTS.md — soul + harness guidance (regenerated on every boot so soul changes propagate)
  // Codex CLI reads this file automatically from the CWD.
  const agentsFile = resolve(workDir, "AGENTS.md");
  const key = agentKey ?? agent.name.toLowerCase();
  writeFileSync(agentsFile, generateAgentsMd(agent, key, instanceSoulsDir));
  logger.debug(`[workspace] Updated ${agentsFile}`);

  // .claude/settings.json — Claude Code hooks for verification
  const isCoder = agent.capabilities?.includes("tool_use") &&
                  (agent.always_cli || agent.cli_fallback);
  if (isCoder) {
    const claudeDir = resolve(workDir, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    const settingsFile = resolve(claudeDir, "settings.json");
    if (!existsSync(settingsFile)) {
      const settings = {
        hooks: {
          Stop: [
            {
              matcher: "",
              hooks: [
                {
                  type: "command",
                  command: `cd ${workDir} && bun run typecheck 2>&1 | head -20`,
                },
              ],
            },
          ],
        },
      };
      writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
      logger.info(`[workspace] Created ${settingsFile} with Stop hooks`);
    }
  }

  // .claude-plugin/plugin.json — skills plugin for CLI agents (regenerated on every boot)
  if (isCoder) {
    generatePluginJson(workDir);
  }

  // .claude/CLAUDE.md — soul-compiled agent instructions (regenerated on every boot)
  if (agentKey) {
    const claudeDir = resolve(workDir, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    const claudeMdFile = resolve(claudeDir, "CLAUDE.md");
    try {
      const soul = loadAndCompileSoul(agentKey, undefined, instanceSoulsDir);
      const claudeMdContent = soul
        ? renderClaudeMd(soul)
        : `# ${agent.name} — NyxHive Agent\n\nRead your soul files at session start (see CLAUDE.md in the repo root).\n`;
      writeFileSync(claudeMdFile, claudeMdContent);
      logger.debug(`[workspace] Updated ${claudeMdFile}`);
    } catch (err) {
      logger.warn(`[workspace] Failed to generate CLAUDE.md for ${agentKey}: ${err}`);
    }
  }

  // PLATFORM.md — platform docs (regenerated on every boot)
  if (config && agentKey) {
    const platformFile = resolve(workDir, "PLATFORM.md");
    let platformContent = generateWorkspaceDocs(config, agentKey, registry, scheduler, memory);

    // Append RUNBOOK.md if it exists (persistent agent-maintained docs)
    const runbookFile = resolve(workDir, "RUNBOOK.md");
    if (existsSync(runbookFile)) {
      platformContent += readFileSync(runbookFile, "utf-8");
    }

    writeFileSync(platformFile, platformContent);
    logger.debug(`[workspace] Updated ${platformFile}`);
  }

  return workDir;
}

function generateAgentsMd(agent: AgentConfig, agentKey?: string, instanceSoulsDir?: string): string {
  // Prefer soul-compiled prompt if a soul file exists for this agent
  const key = agentKey ?? agent.name.toLowerCase();
  let roleContent: string;
  try {
    roleContent = getSoulSystemPrompt(key, undefined, "full", instanceSoulsDir) ?? agent.system_prompt ?? `You are ${agent.name}, an AI assistant.`;
    if (roleContent !== (agent.system_prompt ?? `You are ${agent.name}, an AI assistant.`)) {
      logger.debug(`[workspace] Using soul-compiled prompt for ${agent.name}`);
    }
  } catch {
    roleContent = agent.system_prompt ?? `You are ${agent.name}, an AI assistant.`;
  }
  roleContent = applyAgenticModePrompt(agent, roleContent);

  return `# ${agent.name}

## Role
${roleContent}

## Execution Environment
You are running in a non-interactive automated environment (NyxHive harness). There is no interactive stdin.

- If requirements are unclear, state your assumptions and proceed
- For multi-step tasks, create a task list (todo_write) BEFORE making code changes
- Before declaring implementation complete, run verification and include the output in your response
- If asked to restart the current NyxHive instance itself, use the detached helper \`./scripts/restart-instance.sh --self\` from the repo root so the restart survives your own process exiting.
- Do not run an inline restart command that would kill your own active turn before the restart helper is detached.
- If you truly need user input, output this exact JSON block at the END of your response and stop:

\`\`\`json
{"input_request":{"question":"your question here","options":[{"key":"option1","description":"desc"}]}}
\`\`\`

## Exploration Strategy
Before exploring the codebase broadly, do a targeted semantic pass first:
1. Run search_code with 2-3 keywords from the task description to find the most relevant files
2. Read those files before listing directories
3. Only use list_directory when you need to understand project structure

This is faster than random directory traversal and directly mirrors how top coding agents (ForgeCode #1 on TermBench) orient before acting.

## Execution Principles
- Plan first, implement second, verify last — in that order, every time
- Read the relevant code before proposing or writing changes
- Prefer targeted edits (edit_file) over full rewrites (write_file)
- When a tool fails, diagnose why before retrying — don't loop blindly
- After 3 consecutive all-failure tool turns, the harness will stop — fix the root cause, not symptoms
- Correctness over cleverness; working over perfect
`;
}
