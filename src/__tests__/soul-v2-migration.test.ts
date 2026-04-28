import { describe, test, expect } from "bun:test";
import { resolve } from "path";
import { loadSoulV2Directory } from "../soul/loader-v2.js";
import { compileSoulV2 } from "../soul/compiler-v2.js";
import type { ComposedSoul, ModelTier } from "../soul/types.js";

const SOULS_DIR = resolve(import.meta.dir, "../../souls");

function loadAgent(key: string): ComposedSoul {
  return compileSoulV2(loadSoulV2Directory(SOULS_DIR, key));
}

// --- 1. Identity ---

describe("soul v2 migration — identity", () => {
  const expected: Record<string, { name: string; role: string }> = {
    nyx: { name: "Nyx", role: "lead" },
    analyst: { name: "Analyst", role: "worker" },
    astra: { name: "Astra", role: "worker" },
    tester: { name: "Tester", role: "worker" },
  };

  for (const [key, { name, role }] of Object.entries(expected)) {
    test(`${key}: name="${name}", role="${role}"`, () => {
      const soul = loadAgent(key);
      expect(soul.identity.name).toBe(name);
      expect(soul.identity.role).toBe(role);
    });
  }
});

// --- 2. Model capabilities ---

describe("soul v2 migration — model capabilities", () => {
  const expected: Record<string, { min: ModelTier; default: ModelTier; max: ModelTier }> = {
    nyx: { min: "haiku", default: "sonnet", max: "opus" },
    analyst: { min: "flash-lite", default: "flash-lite", max: "flash" },
    astra: { min: "flash", default: "sonnet", max: "sonnet" },
    tester: { min: "sonnet", default: "sonnet", max: "sonnet" },
  };

  for (const [key, { min, default: def, max }] of Object.entries(expected)) {
    test(`${key}: ${min}/${def}/${max}`, () => {
      const soul = loadAgent(key);
      expect(soul.model_capabilities.min_model).toBe(min);
      expect(soul.model_capabilities.default_model).toBe(def);
      expect(soul.model_capabilities.max_model).toBe(max);
    });
  }
});

// --- 3. Key capabilities ---

describe("soul v2 migration — capabilities", () => {
  test("nyx: invocation=cli, can_read=true, can_write=true, can_run=true", () => {
    const soul = loadAgent("nyx");
    expect(soul.capabilities.invocation).toBe("cli");
    expect(soul.capabilities.can_read_files).toBe(true);
    expect(soul.capabilities.can_write_files).toBe(true);
    expect(soul.capabilities.can_run_commands).toBe(true);
  });

  test("analyst: invocation=sdk, all capabilities locked down (CAPABILITY FIX)", () => {
    const soul = loadAgent("analyst");
    expect(soul.capabilities.invocation).toBe("sdk");
    expect(soul.capabilities.can_read_files).toBe(false);
    expect(soul.capabilities.can_write_files).toBe(false);
    expect(soul.capabilities.can_run_commands).toBe(false);
    expect(soul.capabilities.can_delegate).toBe(false);
  });

  test("astra: invocation=sdk, bounded to tool-based trading work", () => {
    const soul = loadAgent("astra");
    expect(soul.capabilities.invocation).toBe("sdk");
    expect(soul.capabilities.can_read_files).toBe(false);
    expect(soul.capabilities.can_write_files).toBe(false);
    expect(soul.capabilities.can_run_commands).toBe(false);
    expect(soul.capabilities.can_delegate).toBe(false);
    expect(soul.capabilities.mcp_tools).toContain("create_trade_intent");
    expect(soul.capabilities.mcp_tools).toContain("get_trading_lane_state");
  });

  test("tester: invocation=cli, inherits _base read/write/run", () => {
    const soul = loadAgent("tester");
    expect(soul.capabilities.invocation).toBe("cli");
    expect(soul.capabilities.can_read_files).toBe(true);
    expect(soul.capabilities.can_write_files).toBe(true);
    expect(soul.capabilities.can_run_commands).toBe(true);
  });
});

// --- 4. Analyst capability fix (dedicated test) ---

describe("soul v2 migration — analyst capability fix", () => {
  test("analyst: ALL capabilities locked — read=false, write=false, run=false, delegate=false, mcp_tools=[]", () => {
    const soul = loadAgent("analyst");
    expect(soul.capabilities.can_read_files).toBe(false);
    expect(soul.capabilities.can_write_files).toBe(false);
    expect(soul.capabilities.can_run_commands).toBe(false);
    expect(soul.capabilities.can_delegate).toBe(false);
    expect(soul.capabilities.mcp_tools).toEqual([]);
  });
});

// --- 5. MCP tools ---

describe("soul v2 migration — MCP tools", () => {
  test("nyx: has MCP tools (own restricted set)", () => {
    const soul = loadAgent("nyx");
    expect(soul.capabilities.mcp_tools.length).toBeGreaterThan(0);
  });
});

// --- 6. Rules ---

describe("soul v2 migration — rules", () => {
  test("nyx: additive merge includes base rules", () => {
    const soul = loadAgent("nyx");
    const mustRules = soul.rules.must.map((r) => r.rule);

    // Base rule
    expect(mustRules).toContain("Be direct and concise — no filler, no preamble, no restating what was asked (founding rule)");
  });

  test("all agents: must array length > 0", () => {
    const agents = ["nyx", "analyst", "astra", "tester"];
    for (const key of agents) {
      const soul = loadAgent(key);
      expect(soul.rules.must.length).toBeGreaterThan(0);
    }
  });
});

// --- 7. Voice ---

describe("soul v2 migration — voice", () => {
  test("nyx: has voice.traits with length > 0", () => {
    const soul = loadAgent("nyx");
    expect(soul.voice).toBeDefined();
    expect(soul.voice!.traits).toBeDefined();
    expect(soul.voice!.traits!.length).toBeGreaterThan(0);
  });
});

// --- 8. Context strategy ---

describe("soul v2 migration — context strategy", () => {
  test("nyx: context_budget=2000 (no context_mode or inject_recency)", () => {
    const soul = loadAgent("nyx");
    const cs = soul.capabilities.context_strategy;
    expect(cs).toBeDefined();
    expect(cs!.context_budget).toBe(2000);
    expect(cs!.context_mode).toBeUndefined();
    expect(cs!.inject_recency).toBeUndefined();
  });
});
