/**
 * Phase 4.4 — Directory union validation
 *
 * Validates that compileSoul's unionDirectories logic produces no regression
 * against the current NyxAI config.toml directory allowlists.
 *
 * Current config.toml state (as of validation run):
 *   Instance-level allowed_directories: ["/home/user/dev/obsidian/ExampleVault", "/home/user/dev/obsidian/SharedMemory"]
 *   Forge:      ["/home/user/dev", "/home/user/dev/nyxhive", "/home/user/dev/example-mobile", "/home/user/.nyxhive"]
 *   Tester:     ["/home/user/dev", "/home/user/dev/nyxhive", "/home/user/.nyxhive"]
 *   Nyx/Analyst: no explicit allowed_directories (unrestricted)
 *
 * Soul compilation behavior:
 *   unionDirectories([], agentDirs) → agentDirs  (instance empty = unrestricted)
 *   unionDirectories(instanceDirs, []) → instanceDirs  (agent empty = inherit instance)
 *   unionDirectories(instanceDirs, agentDirs) → union of both (never removes paths)
 *
 * No soul TOML files exist yet at /home/user/dev/obsidian/ExampleVault — soul migration
 * is Phase 0 and hasn't been executed. These tests validate the logic pre-migration.
 */

import { describe, test, expect } from "bun:test";
import { compileSoul } from "../soul/compiler.js";
import type { SoulLayer } from "../soul/types.js";

// Instance-level directories from config.toml
const INSTANCE_DIRS = ["/home/user/dev/obsidian/ExampleVault", "/home/user/dev/obsidian/SharedMemory"];

// Per-agent directories from config.toml
const AGENT_DIRS: Record<string, string[]> = {
  forge: ["/home/user/dev", "/home/user/dev/nyxhive", "/home/user/dev/example-mobile", "/home/user/.nyxhive"],
  tester: ["/home/user/dev", "/home/user/dev/nyxhive", "/home/user/.nyxhive"],
  nyx: [],  // unrestricted
  analyst: [],
};

describe("unionDirectories — no agent loses previously accessible paths", () => {
  for (const [agentKey, agentDirs] of Object.entries(AGENT_DIRS)) {
    if (agentDirs.length === 0) continue; // unrestricted agents handled separately

    test(`${agentKey}: all previous paths are present after union with instance dirs`, () => {
      const instanceLayer: SoulLayer = {
        identity: { name: "NyxAI" },
        capabilities: { allowed_directories: INSTANCE_DIRS },
      };
      const agentLayer: SoulLayer = {
        identity: { name: agentKey },
        capabilities: { allowed_directories: agentDirs },
      };
      const soul = compileSoul([instanceLayer, agentLayer]);
      const result = soul.capabilities.allowed_directories;

      // Every path the agent previously had must still be in the union result
      for (const dir of agentDirs) {
        expect(result).toContain(dir);
      }

      // Instance dirs are also added (union is additive — this is expected, not a regression)
      for (const dir of INSTANCE_DIRS) {
        expect(result).toContain(dir);
      }
    });
  }

  test("agent with no explicit dirs inherits instance dirs when instance has dirs", () => {
    // Nyx/Analyst have no allowed_directories in config today.
    // If an instance soul layer defines directories, these agents inherit them.
    // This is NOT a regression of existing access — it's a new restriction.
    // IMPORTANT: When writing soul files, either:
    //   a) Leave instance allowed_directories empty (= unrestricted for all agents), OR
    //   b) Explicitly add each agent's dirs to their soul layer
    const instanceLayer: SoulLayer = {
      identity: { name: "NyxAI" },
      capabilities: { allowed_directories: INSTANCE_DIRS },
    };
    const agentLayer: SoulLayer = {
      identity: { name: "nyx" },
      // No allowed_directories → inherits instance dirs
    };
    const soul = compileSoul([instanceLayer, agentLayer]);
    // Empty agent dirs + non-empty instance dirs → agent gets instance dirs
    expect(soul.capabilities.allowed_directories).toEqual(INSTANCE_DIRS);
    // Note: Nyx currently has unrestricted access. Setting instance-level
    // allowed_directories will restrict these agents. See SOUL_MIGRATION_NOTE below.
  });

  test("empty instance dirs + agent dirs → agent keeps its dirs (unrestricted instance)", () => {
    // If instance soul layer has NO allowed_directories (unrestricted),
    // agent dirs are inherited as-is — no regression possible.
    const instanceLayer: SoulLayer = {
      identity: { name: "NyxAI" },
      // No allowed_directories
    };
    const agentLayer: SoulLayer = {
      identity: { name: "forge" },
      capabilities: { allowed_directories: AGENT_DIRS.forge },
    };
    const soul = compileSoul([instanceLayer, agentLayer]);
    // With empty instance dirs, result = agent dirs only
    for (const dir of AGENT_DIRS.forge) {
      expect(soul.capabilities.allowed_directories).toContain(dir);
    }
  });

  test("union never removes paths — result always >= both input sets", () => {
    // Mathematical property: |union(A, B)| >= |A| and |union(A, B)| >= |B|
    const instanceLayer: SoulLayer = {
      identity: { name: "NyxAI" },
      capabilities: { allowed_directories: INSTANCE_DIRS },
    };
    const agentLayer: SoulLayer = {
      identity: { name: "forge" },
      capabilities: { allowed_directories: AGENT_DIRS.forge },
    };
    const soul = compileSoul([instanceLayer, agentLayer]);
    const result = soul.capabilities.allowed_directories;

    expect(result.length).toBeGreaterThanOrEqual(INSTANCE_DIRS.length);
    expect(result.length).toBeGreaterThanOrEqual(AGENT_DIRS.forge.length);
  });
});

/*
 * SOUL_MIGRATION_NOTE:
 * When creating soul files for Phase 0 (NyxHive dogfood), be aware:
 *
 * Agents with no current allowed_directories (Nyx, Analyst)
 * will be RESTRICTED if the instance soul layer defines allowed_directories.
 *
 * Safe migration options:
 *   1. Don't set allowed_directories at the instance level (leave empty = unrestricted)
 *   2. Explicitly set allowed_directories on each agent soul to match their needs
 *
 * Agents with explicit allowed_directories (Forge, Tester) are safe —
 * the union operation can only ADD paths, never remove them.
 */
