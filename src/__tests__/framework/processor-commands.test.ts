import { describe, it, expect } from "bun:test";
import { matchCommand } from "../../framework/commands.js";
import type { CommandDefinition, CommandContext, CommandResult } from "../../framework/types.js";

describe("processor command dispatch integration", () => {
  const echoCommand: CommandDefinition = {
    name: "echo",
    pattern: /^!echo (.+)/,
    description: "Echo back the input",
    handler: async (ctx: CommandContext): Promise<CommandResult> => {
      return { handled: true, response: `Echo: ${ctx.args[0]}` };
    },
  };

  const silentCommand: CommandDefinition = {
    name: "silent",
    pattern: "!silent",
    description: "Handle silently",
    handler: async (): Promise<CommandResult> => {
      return { handled: true };
    },
  };

  const passCommand: CommandDefinition = {
    name: "pass",
    pattern: "!pass",
    description: "Pass through to LLM",
    handler: async (): Promise<CommandResult> => {
      return { handled: false };
    },
  };

  it("dispatches matching command and returns response", () => {
    const match = matchCommand("!echo hello world", [echoCommand, silentCommand]);
    expect(match).not.toBeNull();
    expect(match!.command.name).toBe("echo");
    expect(match!.args).toEqual(["hello world"]);
  });

  it("returns null for non-matching input", () => {
    const match = matchCommand("normal message", [echoCommand, silentCommand]);
    expect(match).toBeNull();
  });

  it("supports handled:false to fall through", () => {
    const match = matchCommand("!pass", [passCommand]);
    expect(match).not.toBeNull();
  });
});
