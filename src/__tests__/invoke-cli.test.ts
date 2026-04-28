import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  applyNyxHiveCliEnvironment,
  appendClaudeResumeArgs,
  appendCurrentSpeakerPrompt,
  buildClaudeToolExecutionEvent,
  buildCodexCommandExecutionEvent,
  findClaudeSessionOwners,
  formatToolActivity,
  formatToolResultPreview,
  getClaudeSessionBusyRetryDelayMs,
  isLikelyCodexPlanOnlyResponse,
  isClaudeSessionBusyError,
  requiresCodexToolEvidence,
  shouldUseNativeEvidenceReview,
  resolveClaudeReasoningSettings,
  shouldReadCodexPromptFromStdin,
  shouldRetryCodexPlanOnlyTurn,
  shouldUseCodexAppServerRuntime,
  waitForClaudeSessionRelease,
  buildEvidenceReview,
} from "../agents/invoke-cli.js";

const tempDirs: string[] = [];

afterEach(() => {
  delete process.env.NYXHIVE_CLAUDE_SESSIONS_DIR;
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("buildClaudeToolExecutionEvent", () => {
  it("maps bash tool calls to command execution cards", () => {
    const event = buildClaudeToolExecutionEvent("1:0:Bash", "Bash", "completed", {
      command: "rg -n crawl src",
    }, 1);

    expect(event.kind).toBe("command");
    expect(event.turn).toBe(1);
    expect(event.title).toBe("Command run complete");
    expect(event.command).toBe("rg -n crawl src");
    expect(event.subtitle).toContain("rg -n crawl src");
  });

  it("redacts secrets in bash tool execution cards", () => {
    const event = buildClaudeToolExecutionEvent("1:0:Bash", "Bash", "completed", {
      command: "curl -H 'Authorization: Bearer supersecrettokenvalue123456' https://example.com",
    }, 1);

    expect(event.command).toContain("[REDACTED]");
    expect(event.command).not.toContain("supersecrettokenvalue123456");
    expect(event.subtitle).toContain("[REDACTED]");
  });

  it("maps edit tool calls to file change cards", () => {
    const event = buildClaudeToolExecutionEvent("1:1:Edit", "Edit", "completed", {
      file_path: "src/agents/invoke-cli.ts",
    });

    expect(event.kind).toBe("file_change");
    expect(event.title).toBe("File change complete");
    expect(event.changes).toEqual([{ path: "src/agents/invoke-cli.ts", kind: "update" }]);
  });

  it("maps mcp tool names to MCP cards", () => {
    const event = buildClaudeToolExecutionEvent("1:2:mcp", "mcp__nyxhive__crawl_page", "started", {});

    expect(event.kind).toBe("mcp_tool");
    expect(event.title).toBe("Calling MCP tool");
    expect(event.subtitle).toBe("nyxhive/crawl_page");
  });
});

describe("appendCurrentSpeakerPrompt", () => {
  it("adds current speaker guidance for human-readable names", () => {
    const prompt = appendCurrentSpeakerPrompt("Base prompt", "User");

    expect(prompt).toContain("[Current speaker]");
    expect(prompt).toContain("speaking to User");
  });

  it("skips UUID-style machine identities", () => {
    const prompt = appendCurrentSpeakerPrompt("Base prompt", "252f53de-c825-4a3a-8dba-8efa5ca36207");

    expect(prompt).toBe("Base prompt");
    expect(prompt).not.toContain("[Current speaker]");
  });
});

describe("applyNyxHiveCliEnvironment", () => {
  it("disables Claude auto-memory and preserves the explicit auth profile", () => {
    const env = applyNyxHiveCliEnvironment({
      PATH: "/usr/bin",
      CLAUDE_COWORK_MEMORY_PATH_OVERRIDE: "/tmp/rogue-memory",
      CLAUDE_CODE_REMOTE_MEMORY_DIR: "/tmp/remote-memory",
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "0",
    }, "claude", {
      daemon: {
        name: "nyxai",
        log_level: "info",
        data_dir: "/tmp/nyxhive",
        claude_config_dir: "/tmp/claude-profile",
      },
    } as any);

    expect(env.CLAUDE_CONFIG_DIR).toBe("/tmp/claude-profile");
    expect(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe("1");
    expect(env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE).toBeUndefined();
    expect(env.CLAUDE_CODE_REMOTE_MEMORY_DIR).toBeUndefined();
  });

  it("pins CODEX_HOME for codex subprocesses without altering other runtimes", () => {
    const env = applyNyxHiveCliEnvironment({
      PATH: "/usr/bin",
    }, "codex", {
      daemon: {
        name: "nyxai",
        log_level: "info",
        data_dir: "/tmp/nyxhive",
        codex_home: "/tmp/codex-home",
      },
    } as any);

    expect(env.CODEX_HOME).toBe("/tmp/codex-home");
    expect(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBeUndefined();
  });

  it("extends PATH with service search dirs for CLI subprocess dependencies", () => {
    const env = applyNyxHiveCliEnvironment({
      PATH: "/custom/bin",
    }, "codex");

    const entries = env.PATH.split(delimiter);
    expect(entries[0]).toBe("/custom/bin");
    expect(entries).toContain("/opt/homebrew/bin");
    expect(entries).toContain("/usr/bin");
    expect(new Set(entries).size).toBe(entries.length);
  });
});

describe("appendClaudeResumeArgs", () => {
  it("uses --resume instead of re-claiming the session id", () => {
    const args = ["-p", "hello"];
    appendClaudeResumeArgs(args, "session-123");

    expect(args).toEqual(["-p", "hello", "--resume", "session-123"]);
    expect(args).not.toContain("--session-id");
  });

  it("keeps fresh invocations unchanged", () => {
    const args = ["-p", "hello"];
    appendClaudeResumeArgs(args);

    expect(args).toEqual(["-p", "hello"]);
  });
});

describe("formatToolActivity", () => {
  it("redacts raw bash command payloads down to the executable name", () => {
    expect(formatToolActivity("Bash", "python3 -c \"import json\"")).toBe("Running python3");
  });

  it("unwraps shell wrappers so codex command activity shows the real command", () => {
    expect(formatToolActivity("Bash", "/bin/zsh -lc 'rg -n \"token\" src'")).toBe("Running rg");
    expect(formatToolActivity("Bash", "/bin/bash -lc \"sed -n '1,20p' file.txt\"")).toBe("Running sed");
  });

  it("skips comment-only bash prefixes when summarizing shell activity", () => {
    const command = "# Check the export\npython3 -c \"import csv\"";
    expect(formatToolActivity("Bash", command)).toBe("Running python3");
  });

  it("humanizes MCP tool activity for channel progress updates", () => {
    expect(formatToolActivity("mcp__acme__vendit_list_transactions")).toBe("Calling acme/Vendit List Transactions");
  });
});

describe("buildCodexCommandExecutionEvent", () => {
  it("redacts secrets in codex command events", () => {
    const event = buildCodexCommandExecutionEvent(
      "1:cmd",
      "completed",
      "curl -H 'Authorization: Bearer supersecrettokenvalue123456' https://example.com",
      1,
      { outputPreview: "Authorization: Bearer supersecrettokenvalue123456" },
    );

    expect(event.command).toContain("[REDACTED]");
    expect(event.command).not.toContain("supersecrettokenvalue123456");
    expect(event.subtitle).toContain("[REDACTED]");
    expect(event.outputPreview).toContain("[REDACTED]");
  });
});

describe("resolveClaudeReasoningSettings", () => {
  it("disables thinking for lightweight tasks", () => {
    expect(resolveClaudeReasoningSettings("simple_qa")).toEqual({ thinking: "disabled", effort: "low" });
  });

  it("uses adaptive high-effort settings for coding tasks", () => {
    expect(resolveClaudeReasoningSettings("coding")).toEqual({ thinking: "adaptive", effort: "high" });
  });
});

describe("formatToolResultPreview", () => {
  it("redacts secrets before returning command output previews", () => {
    const preview = formatToolResultPreview("Authorization: Bearer supersecrettokenvalue123456");

    expect(preview).toContain("[REDACTED]");
    expect(preview).not.toContain("supersecrettokenvalue123456");
  });
});

describe("Claude resume lock handling", () => {
  it("recognizes transient session-busy resume errors", () => {
    expect(isClaudeSessionBusyError("Error: Session ID e34fb98e-a714-4039-8524-f451b7426e3b is already in use.")).toBe(true);
    expect(isClaudeSessionBusyError("Error: something else happened")).toBe(false);
  });

  it("uses bounded retry backoff for transient session-busy resumes", () => {
    expect(getClaudeSessionBusyRetryDelayMs(0)).toBe(500);
    expect(getClaudeSessionBusyRetryDelayMs(1)).toBe(1000);
    expect(getClaudeSessionBusyRetryDelayMs(2)).toBe(2000);
    expect(getClaudeSessionBusyRetryDelayMs(3)).toBeUndefined();
  });

  it("drops stale session owner files for dead processes", () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), "invoke-cli-sessions-"));
    tempDirs.push(sessionsDir);
    process.env.NYXHIVE_CLAUDE_SESSIONS_DIR = sessionsDir;

    const stalePath = join(sessionsDir, "999999.json");
    writeFileSync(stalePath, JSON.stringify({
      pid: 999999,
      sessionId: "session-dead",
      cwd: "/tmp/dead",
    }));

    expect(findClaudeSessionOwners("session-dead")).toEqual([]);
    expect(existsSync(stalePath)).toBe(false);
  });

  it("waits for a live session owner to exit before resuming", async () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), "invoke-cli-sessions-"));
    tempDirs.push(sessionsDir);
    process.env.NYXHIVE_CLAUDE_SESSIONS_DIR = sessionsDir;

    const proc = Bun.spawn(["/bin/sh", "-c", "sleep 0.2"], { stdout: "ignore", stderr: "ignore" });
    writeFileSync(join(sessionsDir, `${proc.pid}.json`), JSON.stringify({
      pid: proc.pid,
      sessionId: "session-live",
      cwd: "/tmp/live",
    }));

    const result = await waitForClaudeSessionRelease("session-live", { timeoutMs: 1000, pollMs: 25 });
    expect(result.released).toBe(true);
    expect(result.waitedMs).toBeGreaterThan(0);
  });

  it("reports live owners when the session never releases", async () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), "invoke-cli-sessions-"));
    tempDirs.push(sessionsDir);
    process.env.NYXHIVE_CLAUDE_SESSIONS_DIR = sessionsDir;

    const proc = Bun.spawn(["/bin/sh", "-c", "sleep 5"], { stdout: "ignore", stderr: "ignore" });
    writeFileSync(join(sessionsDir, `${proc.pid}.json`), JSON.stringify({
      pid: proc.pid,
      sessionId: "session-busy",
      cwd: "/tmp/busy",
    }));

    try {
      const result = await waitForClaudeSessionRelease("session-busy", { timeoutMs: 50, pollMs: 10 });
      expect(result.released).toBe(false);
      expect(result.owners).toHaveLength(1);
      expect(result.owners[0]?.pid).toBe(proc.pid);
    } finally {
      try { process.kill(proc.pid, "SIGKILL"); } catch { /* ignore */ }
    }
  });
});

describe("formatToolResultPreview", () => {
  it("adds an explicit truncation note when lines are omitted", () => {
    const preview = formatToolResultPreview(["1", "2", "3", "4"].join("\n"), 2);
    expect(preview).toContain("truncated, 2 more lines not shown");
    expect(preview).toContain("Use offset/limit");
  });

  it("keeps short outputs unchanged", () => {
    expect(formatToolResultPreview("all good")).toBe("all good");
  });
});

describe("Codex CLI smoothness helpers", () => {
  it("reads codex prompts from stdin instead of argv", () => {
    expect(shouldReadCodexPromptFromStdin("codex")).toBe(true);
    expect(shouldReadCodexPromptFromStdin("claude")).toBe(false);
  });

  it("detects plan-only codex responses", () => {
    expect(isLikelyCodexPlanOnlyResponse("First, I'll inspect the repo and then I'll make the needed changes.")).toBe(true);
    expect(isLikelyCodexPlanOnlyResponse("Using `$code-review` because this is a commit/change review request. I’m going straight to the live repo state and recent history first, then I’ll inspect the actual diffs before calling anything safe or broken.")).toBe(true);
    expect(isLikelyCodexPlanOnlyResponse("I updated the config and ran the tests.")).toBe(false);
  });

  it("retries only actionable codex tasks that returned plan-only text without tools", () => {
    expect(shouldRetryCodexPlanOnlyTurn("coding", "Let me inspect the codebase first, then I'll patch it.", undefined, false)).toBe(true);
    expect(shouldRetryCodexPlanOnlyTurn("conversation", "Let me think about that.", undefined, false)).toBe(false);
    expect(shouldRetryCodexPlanOnlyTurn("conversation", "I’ll read the recent git history and diffs directly, then give you the engineering take.", undefined, false, "Go read the commits and diffs")).toBe(true);
    expect(shouldRetryCodexPlanOnlyTurn("coding", "Let me inspect the codebase first.", ["command_execution"], false)).toBe(false);
    expect(shouldRetryCodexPlanOnlyTurn("coding", "Let me inspect the codebase first.", undefined, true)).toBe(false);
  });

  it("detects requests that require Codex tool evidence", () => {
    expect(requiresCodexToolEvidence("check your commits and review what changed")).toBe(true);
    expect(requiresCodexToolEvidence("go read the repo history")).toBe(true);
    expect(requiresCodexToolEvidence("good morning")).toBe(false);
  });

  it("uses native evidence review only for non-mutating repo review prompts", () => {
    expect(shouldUseNativeEvidenceReview("check your commits and review what changed")).toBe(true);
    expect(shouldUseNativeEvidenceReview("inspect the harness diffs and tell me what you think")).toBe(true);
    expect(shouldUseNativeEvidenceReview("fix the harness based on the git diff")).toBe(false);
    expect(shouldUseNativeEvidenceReview("run tests and review the output")).toBe(false);
  });

  it("scopes evidence review detection to the current message instead of stale history", () => {
    const contaminatedHistory = [
      "[Conversation History]",
      "Assistant: **Recent Commits Reviewed**",
      "- c4635f43 feat: add context quarantine and skill audit",
      "**Diff Surface**",
      "- src/agents/invoke-cli.ts | 12 +++++",
      "",
      "[Current Message]",
      "u keep spitting that answer from time to time, must be poisoned memory or some sort of wrong action.",
    ].join("\n");

    expect(shouldUseNativeEvidenceReview(contaminatedHistory)).toBe(false);
    expect(requiresCodexToolEvidence(contaminatedHistory)).toBe(false);

    expect(shouldUseNativeEvidenceReview([
      "[Conversation History]",
      "Assistant: previous unrelated repo review",
      "",
      "[Current Message]",
      "check your commits and review what changed",
    ].join("\n"))).toBe(true);
  });

  it("keeps harness evidence review factual instead of returning a canned take", () => {
    const review = buildEvidenceReview([
      { label: "git status --short --branch", output: "## master...origin/master [ahead 2]", exitCode: 0 },
      { label: "git log --oneline --decorate -8", output: "c4635f43 (HEAD -> master) feat: add context quarantine and skill audit", exitCode: 0 },
      { label: "git show --stat --oneline --summary -4", output: "src/agents/invoke-cli.ts | 12 +++++", exitCode: 0 },
    ]);

    expect(review).toContain("**Evidence**");
    expect(review).toContain("git status --short --branch");
    expect(review).not.toContain("The direction is right");
    expect(review).not.toContain("Remaining Risks");
  });

  it("uses codex app-server only when the invocation and env explicitly opt in", () => {
    const agent = {
      name: "Nyx",
      provider: "openai",
      model: "gpt-5.4",
      cli_fallback: "codex",
      working_directory: "/tmp",
    };

    expect(shouldUseCodexAppServerRuntime(agent, undefined, {})).toBe(false);
    expect(shouldUseCodexAppServerRuntime(agent, undefined, { NYXHIVE_CODEX_APP_SERVER: "1" })).toBe(false);
    expect(shouldUseCodexAppServerRuntime(agent, {
      providers: { openai: { runtime: "codex_app_server" } },
    } as any, {})).toBe(true);
    expect(shouldUseCodexAppServerRuntime(agent, undefined, {}, "app_server")).toBe(false);
    expect(shouldUseCodexAppServerRuntime(agent, undefined, { NYXHIVE_CODEX_APP_SERVER: "1" }, "app_server")).toBe(true);
  });
});
