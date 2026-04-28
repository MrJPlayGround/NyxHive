# Dual Brain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow NyxHive to use both Anthropic and OpenAI models simultaneously, routing by task type (codex for coding, opus for conversational), while preserving the ability to force single-brain mode.

**Architecture:** Extend the `--brain` flag to support dual-brain routing. `--brain codex` and `--brain opus` become dual-brain (both providers active, task-type routing). New `--brain codex-only` and `--brain opus-only` suffixes preserve current single-brain behavior. The invoke entry point gains a classification step before the `always_cli` fast path when dual brain is active, swapping agent config to the appropriate brain based on task type.

**Tech Stack:** TypeScript / Bun, existing ProviderRouter classification, existing AgentConfig model override pattern

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/agents/primary.ts` | Modify | Add `DualBrainConfig` type, `buildDualBrainConfig()`, update `resolveMainBrain()` to handle `-only` suffix, update `applyMainBrainOverride()` to return dual brain config |
| `src/agents/invoke.ts` | Modify | Add dual-brain routing in `always_cli` fast path — classify first, swap agent config |
| `src/queue/processor.ts` | Modify | Add `dualBrain` field to `ProcessorConfig`, pass through to `InvokeOpts` |
| `src/framework/create-hive.ts` | Modify | Pass `brainOverride.dualBrain` to processor config, log dual-brain status |
| `src/__tests__/primary-agent.test.ts` | Modify | Add tests for dual brain config, `-only` suffix, brain spec resolution |
| `src/providers/router.ts` | Modify | Add `hasProvider()` method for dual-brain startup validation |
| `src/__tests__/dual-brain-invoke.test.ts` | Create | Test dual-brain routing: coding→codex, conversation→opus, task type mapping |

---

### Task 1: Define DualBrainConfig type and brain spec builder

**Files:**
- Modify: `src/agents/primary.ts`

- [ ] **Step 1: Write the failing test for DualBrainConfig resolution**

In `src/__tests__/primary-agent.test.ts`, add:

```typescript
import { buildDualBrainConfig } from "../agents/primary.js";
// ... existing imports ...

describe("buildDualBrainConfig", () => {
  it("builds coding=codex, conversation=opus when primary is codex", () => {
    const config = buildDualBrainConfig("codex");
    expect(config).not.toBeUndefined();
    expect(config!.primary).toBe("codex");
    expect(config!.coding.provider).toBe("openai");
    expect(config!.coding.model).toBe("gpt-5.4");
    expect(config!.coding.cli_fallback).toBe("codex");
    expect(config!.conversation.provider).toBe("anthropic");
    expect(config!.conversation.model).toBe("claude-opus-4-6");
    expect(config!.conversation.cli_fallback).toBe("claude");
  });

  it("builds coding=codex, conversation=opus when primary is anthropic", () => {
    const config = buildDualBrainConfig("anthropic");
    expect(config).not.toBeUndefined();
    expect(config!.primary).toBe("anthropic");
    expect(config!.conversation.provider).toBe("anthropic");
    expect(config!.conversation.model).toBe("claude-opus-4-6");
    expect(config!.coding.provider).toBe("openai");
    expect(config!.coding.model).toBe("gpt-5.4");
    expect(config!.coding.cli_fallback).toBe("codex");
  });

  it("returns undefined for single-brain mode", () => {
    expect(buildDualBrainConfig(undefined)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/user/dev/nyxhive && bun test src/__tests__/primary-agent.test.ts`
Expected: FAIL — `buildDualBrainConfig` not exported

- [ ] **Step 3: Add the DualBrainConfig type and builder to primary.ts**

In `src/agents/primary.ts`, add the `TaskType` import at the top:

```typescript
import type { TaskType } from "../providers/types.js";
```

Then add after the `MainBrain` type:

```typescript
/** Per-task-type brain specification. */
export interface BrainSpec {
  provider: string;
  model: string;
  cli_fallback: string;
}

/** Dual-brain config — routes coding tasks to one brain, conversational to another. */
export interface DualBrainConfig {
  primary: MainBrain;
  coding: BrainSpec;
  conversation: BrainSpec;
}

/** Task types that route to the coding brain. */
const CODING_TASK_TYPES: Set<TaskType> = new Set(["coding", "code_review"]);

/**
 * Task types that route to the conversation brain.
 * - conversation, analysis, expert, orchestrator: reasoning-heavy, Opus excels here
 * - research, summarization, long_context: these are reasoning/comprehension tasks, not coding
 * Everything else (trivial, simple_qa, classification, worker_subtask) uses the primary brain.
 */
const CONVERSATION_TASK_TYPES: Set<TaskType> = new Set([
  "conversation", "analysis", "expert", "orchestrator",
  "research", "summarization", "long_context",
]);

const CODEX_BRAIN: BrainSpec = { provider: "openai", model: "gpt-5.4", cli_fallback: "codex" };
// Intentionally uses Opus (not Sonnet) for conversation brain — when dual-brain is active,
// conversational tasks should get the best reasoning model regardless of what applyBrain defaults to.
const OPUS_BRAIN: BrainSpec = { provider: "anthropic", model: "claude-opus-4-6", cli_fallback: "claude" };

/**
 * Build a dual-brain config from a resolved MainBrain.
 * Returns undefined if no main brain is set (no --brain flag).
 */
export function buildDualBrainConfig(mainBrain?: MainBrain): DualBrainConfig | undefined {
  if (!mainBrain) return undefined;
  return {
    primary: mainBrain,
    coding: CODEX_BRAIN,
    conversation: OPUS_BRAIN,
  };
}

/**
 * Given a task type and dual-brain config, return the brain spec to use.
 * Falls back to the primary brain's spec for unmatched task types.
 */
export function resolveBrainForTask(taskType: TaskType, config: DualBrainConfig): BrainSpec {
  if (CODING_TASK_TYPES.has(taskType)) return config.coding;
  if (CONVERSATION_TASK_TYPES.has(taskType)) return config.conversation;
  // Lightweight tasks (trivial, simple_qa, research, etc.) use whichever is primary
  return config.primary === "codex" ? config.coding : config.conversation;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/user/dev/nyxhive && bun test src/__tests__/primary-agent.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agents/primary.ts src/__tests__/primary-agent.test.ts
git commit -m "feat: add DualBrainConfig type and builder"
```

---

### Task 2: Support `-only` suffix in resolveMainBrain

**Files:**
- Modify: `src/agents/primary.ts`
- Modify: `src/__tests__/primary-agent.test.ts`

- [ ] **Step 1: Write the failing tests for `-only` suffix**

In `src/__tests__/primary-agent.test.ts`, add to the `"main brain resolution"` describe block:

```typescript
  it("resolves codex-only as codex (single brain)", () => {
    expect(resolveMainBrain("codex-only")).toBe("codex");
  });

  it("resolves opus-only as anthropic (single brain)", () => {
    expect(resolveMainBrain("opus-only")).toBe("anthropic");
  });

  it("detects single-brain mode from -only suffix", () => {
    expect(isSingleBrainMode("codex-only")).toBe(true);
    expect(isSingleBrainMode("opus-only")).toBe(true);
    expect(isSingleBrainMode("codex")).toBe(false);
    expect(isSingleBrainMode("opus")).toBe(false);
    expect(isSingleBrainMode(undefined)).toBe(false);
  });
```

Update the import to include `isSingleBrainMode`:
```typescript
import { applyMainBrainOverride, resolveMainBrain, resolvePrimaryAgentKey, buildDualBrainConfig, isSingleBrainMode } from "../agents/primary.js";
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/user/dev/nyxhive && bun test src/__tests__/primary-agent.test.ts`
Expected: FAIL — `isSingleBrainMode` not exported, `opus-only` not recognized

- [ ] **Step 3: Add `"opus"` to the anthropic aliases in resolveMainBrain**

In `src/agents/primary.ts`, find the alias list in `resolveMainBrain` (line 60):

```typescript
  if (["anthropic", "claude"].includes(normalized)) return "anthropic";
```

Add `"opus"` to the array:

```typescript
  if (["anthropic", "claude", "opus"].includes(normalized)) return "anthropic";
```

Without this, `--brain opus` and `--brain opus-only` will resolve to `undefined` and silently do nothing.

- [ ] **Step 4: Update resolveMainBrain to strip `-only` suffix and add isSingleBrainMode**

In `src/agents/primary.ts`, replace the full `resolveMainBrain` function:

```typescript
export function resolveMainBrain(value?: string | null): MainBrain | undefined {
  const normalized = normalize(value ?? process.env.NYXHIVE_MAIN_BRAIN ?? "");
  if (!normalized) return undefined;
  // Strip -only suffix for resolution (it only affects dual vs single mode)
  const base = normalized.replace(/-?only$/, "");
  if (["anthropic", "claude", "opus"].includes(base)) return "anthropic";
  if (["codex", "openai", "gpt", "gpt5", "gpt-5", "gpt54"].includes(base)) return "codex";
  return undefined;
}

/** Returns true if the brain value uses the `-only` suffix (single-brain mode). */
export function isSingleBrainMode(value?: string | null): boolean {
  const normalized = normalize(value ?? process.env.NYXHIVE_MAIN_BRAIN ?? "");
  return normalized.endsWith("-only");
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd /home/user/dev/nyxhive && bun test src/__tests__/primary-agent.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/agents/primary.ts src/__tests__/primary-agent.test.ts
git commit -m "feat: support --brain opus/codex-only for single-brain mode"
```

---

### Task 3: Update applyMainBrainOverride to emit DualBrainConfig

**Files:**
- Modify: `src/agents/primary.ts`
- Modify: `src/__tests__/primary-agent.test.ts`

- [ ] **Step 1: Write the failing test**

In `src/__tests__/primary-agent.test.ts`, add to the `"applyMainBrainOverride"` describe block:

```typescript
  it("returns dualBrain config in dual-brain mode (--brain codex)", () => {
    process.env.NYXHIVE_MAIN_BRAIN = "codex";
    const result = applyMainBrainOverride(agents, { primary_agent: "nyx" });
    expect(result.dualBrain).toBeDefined();
    expect(result.dualBrain!.primary).toBe("codex");
    expect(result.dualBrain!.coding.provider).toBe("openai");
    expect(result.dualBrain!.conversation.provider).toBe("anthropic");
    delete process.env.NYXHIVE_MAIN_BRAIN;
  });

  it("returns no dualBrain config in single-brain mode (--brain codex-only)", () => {
    process.env.NYXHIVE_MAIN_BRAIN = "codex-only";
    const result = applyMainBrainOverride(agents, { primary_agent: "nyx" });
    expect(result.dualBrain).toBeUndefined();
    // Single brain still swaps agents
    expect(result.agents.nyx.provider).toBe("openai");
    delete process.env.NYXHIVE_MAIN_BRAIN;
  });

  it("dual-brain mode still sets primary agent to specified brain", () => {
    process.env.NYXHIVE_MAIN_BRAIN = "codex";
    const result = applyMainBrainOverride(agents, { primary_agent: "nyx" });
    // Primary agent uses the --brain value as its default
    expect(result.agents.nyx.provider).toBe("openai");
    expect(result.agents.nyx.model).toBe("gpt-5.4");
    delete process.env.NYXHIVE_MAIN_BRAIN;
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/user/dev/nyxhive && bun test src/__tests__/primary-agent.test.ts`
Expected: FAIL — `dualBrain` property not in return type

- [ ] **Step 3: Update applyMainBrainOverride return type and logic**

In `src/agents/primary.ts`, update the function signature and body:

```typescript
export function applyMainBrainOverride(
  agents: Record<string, AgentConfig>,
  config?: Pick<NyxHiveConfig["daemon"], "primary_agent">,
  explicitBrain?: string,
): {
  agents: Record<string, AgentConfig>;
  primaryAgent?: string;
  mainBrain?: MainBrain;
  affectedAgents?: string[];
  dualBrain?: DualBrainConfig;
} {
  const primaryAgent = resolvePrimaryAgentKey(agents, config);
  const mainBrain = resolveMainBrain(explicitBrain);
  const singleBrain = isSingleBrainMode(explicitBrain);

  if (!primaryAgent || !mainBrain || !agents[primaryAgent]) {
    return { agents, primaryAgent, mainBrain };
  }

  const nextAgents: Record<string, AgentConfig> = { ...agents };
  const affectedAgents = new Set<string>([primaryAgent]);

  nextAgents[primaryAgent] = applyBrain(agents[primaryAgent], mainBrain);

  if (mainBrain === "codex") {
    for (const [key, agent] of Object.entries(agents)) {
      if (key === primaryAgent) continue;
      if (agent.role === "heartbeat") continue;
      if (!isAnthropicFamily(agent)) continue;
      nextAgents[key] = applyBrain(agent, mainBrain);
      affectedAgents.add(key);
    }
  }

  // Build dual-brain config unless -only mode
  const dualBrain = singleBrain ? undefined : buildDualBrainConfig(mainBrain);

  return {
    primaryAgent,
    mainBrain,
    affectedAgents: [...affectedAgents],
    agents: nextAgents,
    dualBrain,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/user/dev/nyxhive && bun test src/__tests__/primary-agent.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agents/primary.ts src/__tests__/primary-agent.test.ts
git commit -m "feat: applyMainBrainOverride emits DualBrainConfig for dual-brain mode"
```

---

### Task 4: Plumb dualBrain through ProcessorConfig and InvokeOpts

**Files:**
- Modify: `src/queue/processor.ts` — add `dualBrain` to `ProcessorConfig`, pass to `InvokeOpts`
- Modify: `src/agents/invoke.ts` — add `dualBrain` to `InvokeOpts`
- Modify: `src/framework/create-hive.ts` — pass `brainOverride.dualBrain` to processor

- [ ] **Step 1: Add `dualBrain` to ProcessorConfig**

In `src/queue/processor.ts`, add to the `ProcessorConfig` interface (after `commands`):

```typescript
  dualBrain?: import("../agents/primary.js").DualBrainConfig;
```

- [ ] **Step 2: Add `dualBrain` to InvokeOpts**

In `src/agents/invoke.ts`, add to the `InvokeOpts` interface (after `modelOverride`):

```typescript
  dualBrain?: import("./primary.js").DualBrainConfig;
```

- [ ] **Step 3: Pass dualBrain from processor to invokeAgent**

In `src/queue/processor.ts`, find **all three** `invokeAgent(effectiveConfig, msg.message, {` call sites:

1. **Line ~1343** — primary message processing
2. **Line ~1529** — steer follow-up re-invocation (same agent, not a delegation — must inherit dual brain)
3. **Line ~2338** — thread/API message processing

Add `dualBrain: this.config.dualBrain,` to the opts object after `modelOverride:` in **all three** locations.

Search for pattern: `invokeAgent(effectiveConfig, msg.message, {` and add `dualBrain: this.config.dualBrain,` after `modelOverride:` in each.

Note: do NOT pass dualBrain through the delegation context (`buildDelegationContext` around line 1960). Subagents use their own configured models — dual brain only applies to the primary agent.

- [ ] **Step 4: Pass dualBrain from create-hive to processor**

In `src/framework/create-hive.ts`, in the `new QueueProcessor(queue, {` block (line 286), add after `vault,`:

```typescript
    dualBrain: brainOverride.dualBrain,
```

Add a startup validation check after the processor creation. In `create-hive.ts`, after the `logger.info` for brain override (~line 115), if dual brain is active, verify both providers registered:

```typescript
    if (brainOverride.dualBrain) {
      const hasCoding = router.hasProvider(brainOverride.dualBrain.coding.provider as ProviderName);
      const hasConversation = router.hasProvider(brainOverride.dualBrain.conversation.provider as ProviderName);
      if (!hasCoding || !hasConversation) {
        const missing = !hasCoding ? brainOverride.dualBrain.coding.provider : brainOverride.dualBrain.conversation.provider;
        logger.warn(`[boot] Dual-brain degraded: ${missing} provider unavailable. Falling back to single-brain.`);
        brainOverride.dualBrain = undefined;
      }
    }
```

This requires `ProviderRouter` to have a `hasProvider` method. Check if it exists — if not, add it:

```typescript
// In src/providers/router.ts, add to ProviderRouter class:
hasProvider(name: ProviderName): boolean {
  return this.providers.has(name);
}
```

Also update the log message (line 113-115) to indicate dual-brain mode:

```typescript
    logger.info(
      `Main brain override: ${brainOverride.primaryAgent} -> ${brainOverride.mainBrain} (${agent.provider}/${agent.model}, cli=${agent.cli_fallback ?? "none"})${affected.length ? `; routed subagents: ${affected.join(", ")}` : ""}${brainOverride.dualBrain ? " [dual-brain: coding=" + brainOverride.dualBrain.coding.provider + "/" + brainOverride.dualBrain.coding.model + ", conversation=" + brainOverride.dualBrain.conversation.provider + "/" + brainOverride.dualBrain.conversation.model + "]" : " [single-brain]"}`,
    );
```

- [ ] **Step 5: Run type check**

Run: `cd /home/user/dev/nyxhive && bunx tsc --noEmit`
Expected: PASS (no type errors)

- [ ] **Step 6: Commit**

```bash
git add src/queue/processor.ts src/agents/invoke.ts src/framework/create-hive.ts
git commit -m "feat: plumb dualBrain config through processor to invoke"
```

---

### Task 5: Implement dual-brain routing in invokeAgent

**Files:**
- Modify: `src/agents/invoke.ts`

This is the core change. The `always_cli` fast path (lines 204-212) currently skips classification entirely. For dual-brain mode, we classify first and swap the agent config to the appropriate brain.

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/dual-brain-invoke.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import { resolveBrainForTask, type DualBrainConfig } from "../agents/primary.js";

const dualBrain: DualBrainConfig = {
  primary: "codex",
  coding: { provider: "openai", model: "gpt-5.4", cli_fallback: "codex" },
  conversation: { provider: "anthropic", model: "claude-opus-4-6", cli_fallback: "claude" },
};

describe("resolveBrainForTask", () => {
  it("routes coding tasks to coding brain", () => {
    const brain = resolveBrainForTask("coding", dualBrain);
    expect(brain.provider).toBe("openai");
    expect(brain.cli_fallback).toBe("codex");
  });

  it("routes code_review to coding brain", () => {
    const brain = resolveBrainForTask("code_review", dualBrain);
    expect(brain.provider).toBe("openai");
  });

  it("routes conversation to conversation brain", () => {
    const brain = resolveBrainForTask("conversation", dualBrain);
    expect(brain.provider).toBe("anthropic");
    expect(brain.cli_fallback).toBe("claude");
  });

  it("routes analysis to conversation brain", () => {
    const brain = resolveBrainForTask("analysis", dualBrain);
    expect(brain.provider).toBe("anthropic");
  });

  it("routes expert to conversation brain", () => {
    const brain = resolveBrainForTask("expert", dualBrain);
    expect(brain.provider).toBe("anthropic");
  });

  it("routes orchestrator to conversation brain", () => {
    const brain = resolveBrainForTask("orchestrator", dualBrain);
    expect(brain.provider).toBe("anthropic");
  });

  it("routes trivial to primary brain (codex when primary=codex)", () => {
    const brain = resolveBrainForTask("trivial", dualBrain);
    expect(brain.provider).toBe("openai"); // primary is codex
  });

  it("routes trivial to primary brain (anthropic when primary=anthropic)", () => {
    const opusPrimary: DualBrainConfig = { ...dualBrain, primary: "anthropic" };
    const brain = resolveBrainForTask("trivial", opusPrimary);
    expect(brain.provider).toBe("anthropic");
  });

  it("routes simple_qa to primary brain", () => {
    const brain = resolveBrainForTask("simple_qa", dualBrain);
    expect(brain.provider).toBe("openai"); // primary is codex
  });

  it("routes research to conversation brain (reasoning task)", () => {
    const brain = resolveBrainForTask("research", dualBrain);
    expect(brain.provider).toBe("anthropic");
  });

  it("routes summarization to conversation brain", () => {
    const brain = resolveBrainForTask("summarization", dualBrain);
    expect(brain.provider).toBe("anthropic");
  });

  it("routes long_context to conversation brain", () => {
    const brain = resolveBrainForTask("long_context", dualBrain);
    expect(brain.provider).toBe("anthropic");
  });

  it("routes worker_subtask to primary brain", () => {
    const brain = resolveBrainForTask("worker_subtask", dualBrain);
    expect(brain.provider).toBe("openai"); // primary is codex
  });
});
```

- [ ] **Step 2: Run test to verify it passes** (resolveBrainForTask was already implemented in Task 1)

Run: `cd /home/user/dev/nyxhive && bun test src/__tests__/dual-brain-invoke.test.ts`
Expected: PASS

- [ ] **Step 3: Implement dual-brain routing in the always_cli fast path**

In `src/agents/invoke.ts`, replace the `always_cli` block (lines 204-212):

```typescript
  // Agent configured to always use CLI
  if (agent.always_cli && agent.cli_fallback) {
    // Dual-brain mode: classify first, then pick the right brain
    if (opts.dualBrain && !opts.modelOverride) {
      const taskType = opts.router.classifyLocal(message);
      const brainSpec = resolveBrainForTask(taskType, opts.dualBrain);
      const swapped = brainSpec.provider !== agent.provider;
      const effectiveAgent: AgentConfig = swapped
        ? { ...agent, provider: brainSpec.provider, model: brainSpec.model, cli_fallback: brainSpec.cli_fallback }
        : agent;

      logger.info(`[classify] ${JSON.stringify({ type: taskType, method: "dual_brain", confidence: 0.9, agent: agent.name, model: effectiveAgent.model, provider: effectiveAgent.provider, invocation: effectiveAgent.cli_fallback === "codex" ? "codex" : "cli", swapped, message: message.slice(0, 80) })}`);
      logger.info(`[invoke] Routing: dual_brain(${taskType}) → ${effectiveAgent.cli_fallback === "codex" ? "Codex" : "CLI"} for ${agent.name} (${effectiveAgent.provider}/${effectiveAgent.model})`);

      if (effectiveAgent.cli_fallback === "codex") {
        return invokeCodex(effectiveAgent, message, opts, startTime, taskType);
      }
      return invokeCLI(effectiveAgent, message, opts, startTime, taskType);
    }

    // Single-brain mode (or no dual brain): original behavior
    logger.info(`[classify] ${JSON.stringify({ type: "orchestrator", method: "always_cli", confidence: 1.0, agent: agent.name, model: agent.model, provider: agent.provider, invocation: agent.cli_fallback === "codex" ? "codex" : "cli", message: message.slice(0, 80) })}`);
    logger.info(`[invoke] Routing: always_cli → ${agent.cli_fallback === "codex" ? "Codex" : "CLI"} for ${agent.name}`);
    if (agent.cli_fallback === "codex") {
      return invokeCodex(agent, message, opts, startTime, "orchestrator");
    }
    return invokeCLI(agent, message, opts, startTime, "orchestrator");
  }
```

Add the import at the top of `invoke.ts`:

```typescript
import { resolveBrainForTask } from "./primary.js";
```

- [ ] **Step 4: Run type check**

Run: `cd /home/user/dev/nyxhive && bunx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Run all tests**

Run: `cd /home/user/dev/nyxhive && bun test src/__tests__/primary-agent.test.ts src/__tests__/dual-brain-invoke.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/agents/invoke.ts src/__tests__/dual-brain-invoke.test.ts
git commit -m "feat: dual-brain routing in invokeAgent — classify then pick brain"
```

---

### Task 6: Verify end-to-end and clean up

**Files:**
- All modified files

- [ ] **Step 1: Run full test suite**

Run: `cd /home/user/dev/nyxhive && bun test`
Expected: All tests pass

- [ ] **Step 2: Run type check**

Run: `cd /home/user/dev/nyxhive && bunx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Manual smoke test — verify logging**

Start with `--brain codex` and send a conversational message. Check logs for:
```
[invoke] Routing: dual_brain(conversation) → CLI for Nyx (anthropic/claude-opus-4-6)
```

Send a coding message. Check logs for:
```
[invoke] Routing: dual_brain(coding) → Codex for Nyx (openai/gpt-5.4)
```

Start with `--brain codex-only` and verify original single-brain behavior:
```
[invoke] Routing: always_cli → Codex for Nyx
```

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "feat: dual-brain support — route by task type with --brain, single mode with --brain X-only"
```
