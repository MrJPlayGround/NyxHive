// src/framework/commands.ts
import type { CommandDefinition } from "./types.js";

export interface CommandMatch {
  command: CommandDefinition;
  args: string[];
}

export function matchCommand(
  content: string,
  commands: CommandDefinition[]
): CommandMatch | null {
  const trimmed = content.trim();

  for (const command of commands) {
    if (typeof command.pattern === "string") {
      if (trimmed === command.pattern) {
        return { command, args: [] };
      }
    } else {
      const match = trimmed.match(command.pattern);
      if (match) {
        return { command, args: match.slice(1) };
      }
    }
  }

  return null;
}
