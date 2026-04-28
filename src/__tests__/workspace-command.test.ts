import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}

describe("workspace command surface", () => {
  test("includes doctor and scaffold subcommands alongside start/stop/status", () => {
    const content = source("src/nyx/commands/workspace.ts");
    expect(content).toContain("const doctor = defineCommand");
    expect(content).toContain("const scaffold = defineCommand");
    expect(content).toContain("subCommands: { list, status, start, stop, command, doctor, scaffold }");
  });
});
