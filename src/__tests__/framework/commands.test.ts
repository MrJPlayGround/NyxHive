import { describe, it, expect } from "bun:test";
import { matchCommand } from "../../framework/commands.js";
import type { CommandDefinition } from "../../framework/types.js";

describe("matchCommand", () => {
  const commands: CommandDefinition[] = [
    {
      name: "drift-review",
      pattern: /^morph:api-drift-review$/,
      description: "Run API drift review",
      handler: async () => ({ handled: true, response: "Review started" }),
    },
    {
      name: "status",
      pattern: "status",
      description: "Show status",
      handler: async () => ({ handled: true, response: "OK" }),
    },
  ];

  it("matches regex pattern and extracts no args", () => {
    const result = matchCommand("morph:api-drift-review", commands);
    expect(result).not.toBeNull();
    expect(result!.command.name).toBe("drift-review");
    expect(result!.args).toEqual([]);
  });

  it("matches string pattern (exact)", () => {
    const result = matchCommand("status", commands);
    expect(result).not.toBeNull();
    expect(result!.command.name).toBe("status");
  });

  it("returns null for no match", () => {
    const result = matchCommand("hello world", commands);
    expect(result).toBeNull();
  });

  it("matches regex with capture groups as args", () => {
    const cmds: CommandDefinition[] = [
      {
        name: "deploy",
        pattern: /^deploy\s+(\S+)\s+(\S+)$/,
        description: "Deploy a service",
        handler: async () => ({ handled: true }),
      },
    ];
    const result = matchCommand("deploy api production", cmds);
    expect(result).not.toBeNull();
    expect(result!.args).toEqual(["api", "production"]);
  });

  it("trims whitespace before matching", () => {
    const result = matchCommand("  status  ", commands);
    expect(result).not.toBeNull();
    expect(result!.command.name).toBe("status");
  });

  it("returns first match when multiple could match", () => {
    const cmds: CommandDefinition[] = [
      { name: "first", pattern: /^test$/, description: "First", handler: async () => ({ handled: true }) },
      { name: "second", pattern: /^test$/, description: "Second", handler: async () => ({ handled: true }) },
    ];
    const result = matchCommand("test", cmds);
    expect(result!.command.name).toBe("first");
  });
});
