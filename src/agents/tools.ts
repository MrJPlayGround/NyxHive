/**
 * SDK tools for the tool loop.
 * Read tools let agents inspect code; write tools let agents modify code.
 * Write tools are gated behind `writable` flag in ToolContext.
 */

import { readFileSync, writeFileSync, readdirSync, statSync, realpathSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve, dirname, relative, isAbsolute } from "node:path";
import { spawnSync } from "node:child_process";
import type { ToolDefinition, ToolCall } from "../providers/types.js";
import { formatError } from "../utils/error.js";
import type { KnowledgeStore } from "../memory/knowledge.js";
import type { EmbeddingProvider } from "../memory/embeddings.js";
import type { CompiledKnowledgeStore } from "../memory/compiled-knowledge.js";
import { formatCompiledKnowledgeContext } from "../memory/compiled-knowledge.js";
import { braveWebSearch } from "../mcp/brave-search.js";

export interface ToolContext {
  workDir: string;
  allowedDirectories?: string[];
  knowledge?: KnowledgeStore;
  compiledKnowledge?: CompiledKnowledgeStore;
  embedder?: EmbeddingProvider;
  writable?: boolean;
  onFileChange?: (change: { filePath: string; operation: string; linesAdded: number; linesRemoved: number; diffSummary?: string }) => void;
  /**
   * Context-pressure-aware output limit. Defaults to MAX_TOOL_OUTPUT (8000).
   * ForgeCode principle: reduce tool output size as context fills to prevent late-session floods.
   */
  maxOutputChars?: number;
}

export const SDK_TOOLS: ToolDefinition[] = [
  {
    name: "read_file",
    description: "Read a file's contents. Specify optional offset and limit for large files.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to workspace" },
        offset: { type: "number", description: "Line number to start from (1-indexed)" },
        limit: { type: "number", description: "Max lines to read" },
      },
      required: ["path"],
    },
  },
  {
    name: "search_files",
    description: "Find files matching a glob pattern.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern, e.g. 'src/**/*.ts'" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "search_code",
    description: "Search for a regex pattern in code files. Returns matching lines with file paths.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regex pattern to search for" },
        glob: { type: "string", description: "File glob to limit search scope" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "list_directory",
    description: "List files and directories at a path.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory path relative to workspace" },
      },
      required: [],
    },
  },
  {
    name: "search_knowledge",
    description: "Search the knowledge store for relevant learnings, patterns, and documentation. Use before starting tasks to check if similar work has been done, or to find established patterns and past decisions.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural language search query" },
        limit: { type: "number", description: "Max results (default 5, max 20)" },
        category: { type: "string", description: "Filter by category (optional, e.g. 'rejected-proposals', 'post-mortems', 'code-patterns')" },
      },
      required: ["query"],
    },
  },
];

/** Utility tools — always available for agents with tool_use, regardless of write access. */
export const SDK_UTILITY_TOOLS: ToolDefinition[] = [
  {
    name: "todo_write",
    description: "Create or update the task list for the current work session. Call this BEFORE making code changes on multi-step tasks. Each call replaces the full list — include all todos, not just new ones. Use status 'pending', 'in_progress', or 'completed'. Only one task should be 'in_progress' at a time.",
    parameters: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          description: "Full task list for this session",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Short unique ID, e.g. '1', '2'" },
              content: { type: "string", description: "Task description (imperative form)" },
              status: { type: "string", enum: ["pending", "in_progress", "completed"] },
            },
            required: ["id", "content", "status"],
          },
        },
      },
      required: ["todos"],
    },
  },
  {
    name: "todo_read",
    description: "Read the current task list for this session.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "web_search",
    description: "Search the public web with Brave and return concise result summaries with titles and URLs. Useful for current events, research, documentation, and recommendations when internal knowledge is insufficient.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        count: { type: "number", description: "Number of results to return (default 5, max 10)" },
        freshness: { type: "string", description: "Optional freshness filter: pd, pw, pm, or py" },
      },
      required: ["query"],
    },
  },
  {
    name: "web_fetch",
    description: "Fetch a URL and return its text content. Useful for reading documentation, checking APIs, or retrieving reference material. Returns cleaned text (HTML tags stripped).",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to fetch" },
        max_chars: { type: "number", description: "Max characters to return (default 4000, max 8000)" },
      },
      required: ["url"],
    },
  },
];

/** Write tools — only provided to agents with writable ToolContext. */
export const SDK_WRITE_TOOLS: ToolDefinition[] = [
  {
    name: "write_file",
    description: "Write content to a file. Creates parent directories if needed. Overwrites existing files.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to workspace" },
        content: { type: "string", description: "File content to write" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    description: "Replace a specific string in a file. old_string must match exactly (including whitespace). Use for targeted edits.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to workspace" },
        old_string: { type: "string", description: "Exact text to find and replace" },
        new_string: { type: "string", description: "Replacement text" },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
  {
    name: "run_command",
    description: "Run a shell command in the workspace directory. Use for builds, tests, linting. Max 30s timeout.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to execute" },
      },
      required: ["command"],
    },
  },
];

// Max output per tool call to prevent context blowup
const MAX_TOOL_OUTPUT = 8000;

// Task list file stored per workspace session
const TODOS_FILE = ".nyxhive-todos.json";

export interface PathValidationResult {
  valid: boolean;
  resolved: string;
  error?: string;
}

function resolveComparablePath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function isPathContained(candidate: string, base: string): boolean {
  const relativePath = relative(base, candidate);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function canonicalizeCandidatePath(
  candidate: string,
  bases: Array<{ input: string; canonical: string }>,
): string {
  try {
    return realpathSync(candidate);
  } catch {
    const normalizedCandidate = resolve(candidate);

    for (const base of bases) {
      if (!isPathContained(normalizedCandidate, base.input)) continue;
      return resolve(base.canonical, relative(base.input, normalizedCandidate));
    }

    return normalizedCandidate;
  }
}

/**
 * Validate that a file path is within allowed directories.
 * Resolves the path relative to workDir, follows symlinks when possible,
 * then checks the result is within workDir or allowedDirectories.
 */
export function validateFilePath(
  path: string,
  workDir: string,
  allowedDirectories?: string[],
): PathValidationResult {
  // Reject null bytes — can truncate paths in C-based syscalls
  if (path.includes("\0")) {
    return { valid: false, resolved: path, error: "Invalid path (null byte)" };
  }

  const resolved = resolve(workDir, path);
  const allowedBases = [workDir, ...(allowedDirectories ?? [])].map((dir) => ({
    input: resolve(dir),
    canonical: resolveComparablePath(dir),
  }));
  const realPath = canonicalizeCandidatePath(resolved, allowedBases);
  const isAllowed = allowedBases.some((base) => isPathContained(realPath, base.canonical));

  if (!isAllowed) {
    return {
      valid: false,
      resolved: realPath,
      error: `Path "${path}" resolves to "${realPath}" which is outside allowed directories`,
    };
  }

  return { valid: true, resolved: realPath };
}

function isPathAllowed(resolved: string, workDir: string, allowedDirs?: string[]): boolean {
  return validateFilePath(resolved, workDir, allowedDirs).valid;
}

function expandSearchCodeGlobs(globPattern?: string): string[] {
  if (!globPattern) {
    return ["**/*"];
  }
  const isNegated = globPattern.startsWith("!");
  const normalizedPattern = isNegated ? globPattern.slice(1) : globPattern;
  if (normalizedPattern.includes("/")) {
    return [globPattern];
  }
  const expandedPatterns = [normalizedPattern, `**/${normalizedPattern}`];
  return expandedPatterns.map(pattern => (isNegated ? `!${pattern}` : pattern));
}

function executeSearchCodeFallback(
  workDir: string,
  pattern: string,
  globPattern?: string,
  allowedDirectories?: string[],
  maxOutput = MAX_TOOL_OUTPUT,
): string {
  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch (error) {
    return `Error: invalid regex pattern: ${formatError(error)}`;
  }

  const matches: string[] = [];
  const seenFiles = new Set<string>();
  const globPatterns = expandSearchCodeGlobs(globPattern);

  for (const scanPattern of globPatterns) {
    const glob = new Bun.Glob(scanPattern);
    for (const match of glob.scanSync({ cwd: workDir, onlyFiles: true })) {
      if (seenFiles.has(match)) continue;
      seenFiles.add(match);

      if (match.startsWith(".git/") || match.startsWith("node_modules/")) continue;

      const resolved = resolve(workDir, match);
      if (!isPathAllowed(resolved, workDir, allowedDirectories)) continue;

      let content: string;
      try {
        content = readFileSync(resolved, "utf-8");
      } catch {
        continue;
      }

      const lines = content.split("\n");
      for (let index = 0; index < lines.length; index += 1) {
        regex.lastIndex = 0;
        if (!regex.test(lines[index])) continue;

        matches.push(`./${match}:${index + 1}:${lines[index]}`);
        if (matches.length >= 30) {
          return matches.join("\n").slice(0, maxOutput);
        }
      }
    }
  }

  return matches.join("\n").slice(0, maxOutput) || "No matches found.";
}
export async function executeTool(tool: ToolCall, ctx: ToolContext): Promise<string>;
export async function executeTool(tool: ToolCall, workDir: string): Promise<string>;
export async function executeTool(tool: ToolCall, ctxOrWorkDir: ToolContext | string): Promise<string> {
  const ctx: ToolContext = typeof ctxOrWorkDir === "string" ? { workDir: ctxOrWorkDir } : ctxOrWorkDir;
  const workDir = ctx.workDir;
  const maxOutput = ctx.maxOutputChars ?? MAX_TOOL_OUTPUT;
  try {
    switch (tool.name) {
      case "read_file": {
        // Security: ensure path stays within workspace or allowed directories
        const resolved = resolve(workDir, tool.arguments.path as string);
        if (!isPathAllowed(resolved, workDir, ctx.allowedDirectories)) return "Error: path outside allowed directories";
        const content = readFileSync(resolved, "utf-8");
        const lines = content.split("\n");
        const offset = ((tool.arguments.offset as number) ?? 1) - 1;
        const limit = (tool.arguments.limit as number) ?? lines.length;
        const sliced = lines.slice(offset, offset + limit);
        const result = sliced.map((l, i) => `${offset + i + 1}\t${l}`).join("\n");
        return result.slice(0, maxOutput);
      }

      case "search_files": {
        const pattern = tool.arguments.pattern as string;
        // Reject patterns that attempt directory escape
        if (pattern.includes("\0")) return "Error: invalid pattern (null byte)";
        const glob = new Bun.Glob(pattern);
        const matches = [...glob.scanSync({ cwd: workDir, onlyFiles: true })]
          .filter(m => {
            // Ensure resolved match stays within workDir or allowed directories
            const resolved = resolve(workDir, m);
            return isPathAllowed(resolved, workDir, ctx.allowedDirectories);
          })
          .slice(0, 50);
        return matches.join("\n") || "No files found.";
      }

      case "search_code": {
        const pattern = tool.arguments.pattern as string;
        if (pattern.includes("\0")) return "Error: invalid pattern (null byte)";
        const globPattern = tool.arguments.glob as string | undefined;
        const expandedGlobs = globPattern ? expandSearchCodeGlobs(globPattern) : undefined;
        const rgArgs = [
          "--no-heading", "-n", pattern,
          ...(expandedGlobs ? expandedGlobs.flatMap(glob => ["--glob", glob]) : []),
          ".",
        ];
        // rg is scoped to cwd (workDir) — no --follow to avoid symlink escapes
        const result = spawnSync("rg", rgArgs, { cwd: workDir, encoding: "utf-8", timeout: 5000 });
        if (result.error) {
          const error = result.error as NodeJS.ErrnoException;
          if (error.code === "ENOENT") {
            return executeSearchCodeFallback(workDir, pattern, globPattern, ctx.allowedDirectories, maxOutput);
          }
          return `Error: failed to run ripgrep: ${formatError(result.error)}`;
        }

        if (result.status && result.status > 1) {
          const errorOutput = (result.stderr ?? "").trim();
          return errorOutput ? `Error: ${errorOutput}` : "Error: ripgrep search failed.";
        }

        const output = (result.stdout ?? "").trim();
        if (output) {
          const lines = output.split("\n").slice(0, 30).join("\n");
          return lines.slice(0, maxOutput);
        }

        const missingRg =
          (result as { error?: NodeJS.ErrnoException }).error?.code === "ENOENT" ||
          result.status === null;
        if (!missingRg) {
          return "No matches found.";
        }
        return executeSearchCodeFallback(workDir, pattern, globPattern, ctx.allowedDirectories, maxOutput);
      }

      case "list_directory": {
        const resolved = resolve(workDir, (tool.arguments.path as string) ?? ".");
        if (!isPathAllowed(resolved, workDir, ctx.allowedDirectories)) return "Error: path outside allowed directories";
        const entries = readdirSync(resolved).map((name) => {
          try {
            const stat = statSync(join(resolved, name));
            return `${stat.isDirectory() ? "d" : "f"}\t${name}`;
          } catch {
            return `?\t${name}`;
          }
        });
        return entries.join("\n").slice(0, maxOutput);
      }

      case "search_knowledge": {
        if (!ctx.knowledge && !ctx.compiledKnowledge) {
          return "Knowledge store not available.";
        }
        const query = tool.arguments.query as string;
        if (!query) return "Error: query is required";
        const limit = Math.min(Math.max((tool.arguments.limit as number) ?? 5, 1), 20);
        const category = tool.arguments.category as string | undefined;
        const compiledResults = ctx.compiledKnowledge?.search(query, {
          keywords: query.split(/\s+/).filter((token) => token.length >= 3),
          ...(category ? { categoryBoost: [category] } : {}),
        }, Math.min(limit, 3)) ?? [];

        let formattedKnowledge = "";
        if (ctx.knowledge && ctx.embedder) {
          const embedding = await ctx.embedder.embed(query);
          let results = ctx.knowledge.search(embedding, limit, 0.60, undefined, category, query);
          if (category) {
            results = results.filter((result) => result.category === category);
          }
          if (results.length > 0) {
            const formatted = results.map((r, i) => {
              const snippet = r.content.length > 500 ? `${r.content.slice(0, 500)}...` : r.content;
              const agent = r.source_agent ? ` (learned by ${r.source_agent})` : "";
              return `[${i + 1}] ${r.title} (similarity: ${r.similarity!.toFixed(2)})${agent}\nCategory: ${r.category ?? "uncategorized"}\n---\n${snippet}`;
            });
            formattedKnowledge = `Found ${results.length} result${results.length === 1 ? "" : "s"}:\n\n${formatted.join("\n\n")}`;
          }
        }

        const compiledSection = compiledResults.length > 0
          ? [
              `Compiled digests (${compiledResults.length}):`,
              formatCompiledKnowledgeContext(compiledResults.map((result) => result.page)) ?? "",
            ].join("\n\n").trim()
          : "";

        if (!formattedKnowledge && !compiledSection) {
          return "No relevant knowledge found.";
        }
        return [compiledSection, formattedKnowledge].filter(Boolean).join("\n\n").slice(0, maxOutput);
      }

      case "write_file": {
        if (!ctx.writable) return "Error: write access not enabled for this agent";
        const filePath = tool.arguments.path as string;
        const content = tool.arguments.content as string;
        const resolved = resolve(workDir, filePath);
        if (!isPathAllowed(resolved, workDir, ctx.allowedDirectories)) return "Error: path outside allowed directories";
        const dir = dirname(resolved);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        const isNew = !existsSync(resolved);
        writeFileSync(resolved, content, "utf-8");
        if (ctx.onFileChange) {
          const lines = content.split('\n').length;
          ctx.onFileChange({
            filePath,
            operation: isNew ? 'create' : 'write',
            linesAdded: lines,
            linesRemoved: 0,
          });
        }
        return `Wrote ${content.length} bytes to ${filePath}`;
      }

      case "edit_file": {
        if (!ctx.writable) return "Error: write access not enabled for this agent";
        const filePath = tool.arguments.path as string;
        const oldStr = tool.arguments.old_string as string;
        const newStr = tool.arguments.new_string as string;
        const resolved = resolve(workDir, filePath);
        if (!isPathAllowed(resolved, workDir, ctx.allowedDirectories)) return "Error: path outside allowed directories";
        if (!existsSync(resolved)) return `Error: file not found: ${filePath}`;
        const current = readFileSync(resolved, "utf-8");
        if (!current.includes(oldStr)) return `Error: old_string not found in ${filePath}`;
        const occurrences = current.split(oldStr).length - 1;
        if (occurrences > 1) return `Error: old_string matches ${occurrences} times in ${filePath} — provide more context to make it unique`;
        const updated = current.replace(oldStr, newStr);
        writeFileSync(resolved, updated, "utf-8");
        if (ctx.onFileChange) {
          const oldLines = oldStr.split('\n').length;
          const newLines = newStr.split('\n').length;
          const diffLines = [
            ...oldStr.split('\n').slice(0, 5).map(l => `-${l}`),
            ...newStr.split('\n').slice(0, 5).map(l => `+${l}`),
          ].join('\n');
          ctx.onFileChange({
            filePath,
            operation: 'edit',
            linesAdded: Math.max(0, newLines - oldLines),
            linesRemoved: Math.max(0, oldLines - newLines),
            diffSummary: `@@ edit @@\n${diffLines}`.slice(0, 500),
          });
        }
        return `Edited ${filePath} (replaced ${oldStr.length} chars with ${newStr.length} chars)`;
      }

      case "run_command": {
        if (!ctx.writable) return "Error: command execution not enabled for this agent";
        const command = tool.arguments.command as string;
        // Safety: block obviously dangerous commands
        const blocked = [/\brm\s+-rf\s+[\/~]/, /\bgit\s+push\b.*--force/, /\bcurl\b.*\|\s*sh/];
        for (const re of blocked) {
          if (re.test(command)) return `Error: command blocked by safety policy: ${command}`;
        }
        const result = spawnSync("sh", ["-c", command], {
          cwd: workDir,
          encoding: "utf-8",
          timeout: 30_000,
          env: { ...process.env, HOME: process.env.HOME, PATH: process.env.PATH },
        });
        const stdout = (result.stdout ?? "").trim();
        const stderr = (result.stderr ?? "").trim();
        const exitCode = result.status ?? -1;
        const output = [
          exitCode !== 0 ? `Exit code: ${exitCode}` : "",
          stdout,
          stderr ? `STDERR:\n${stderr}` : "",
        ].filter(Boolean).join("\n");
        return output.slice(0, maxOutput) || "(no output)";
      }

      case "todo_write": {
        const todos = tool.arguments.todos as Array<{ id: string; content: string; status: string }>;
        if (!Array.isArray(todos)) return "Error: todos must be an array";
        const todosPath = resolve(workDir, TODOS_FILE);
        writeFileSync(todosPath, JSON.stringify(todos, null, 2), "utf-8");
        const lines = todos.map((t) => {
          const icon = t.status === "completed" ? "[x]" : t.status === "in_progress" ? "[~]" : "[ ]";
          return `${icon} ${t.id}. ${t.content}`;
        });
        return `Task list updated (${todos.length} items):\n${lines.join("\n")}`;
      }

      case "todo_read": {
        const todosPath = resolve(workDir, TODOS_FILE);
        if (!existsSync(todosPath)) return "No task list found. Use todo_write to create one.";
        const raw = readFileSync(todosPath, "utf-8");
        const todos = JSON.parse(raw) as Array<{ id: string; content: string; status: string }>;
        if (!todos.length) return "Task list is empty.";
        const lines = todos.map((t) => {
          const icon = t.status === "completed" ? "[x]" : t.status === "in_progress" ? "[~]" : "[ ]";
          return `${icon} ${t.id}. ${t.content}`;
        });
        return lines.join("\n");
      }

      case "web_fetch": {
        const url = tool.arguments.url as string;
        if (!url?.startsWith("http")) return "Error: url must start with http or https";
        const maxChars = Math.min(Math.max((tool.arguments.max_chars as number) ?? 4000, 100), 8000);
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 15_000);
          let text: string;
          try {
            const res = await fetch(url, {
              signal: controller.signal,
              headers: { "User-Agent": "NyxHive/1.0 (AI agent; research only)" },
            });
            if (!res.ok) return `Error: HTTP ${res.status} ${res.statusText}`;
            text = await res.text();
          } finally {
            clearTimeout(timeout);
          }
          // Strip HTML tags and condense whitespace
          const stripped = text
            .replace(/<script[\s\S]*?<\/script>/gi, "")
            .replace(/<style[\s\S]*?<\/style>/gi, "")
            .replace(/<[^>]+>/g, " ")
            .replace(/&nbsp;/g, " ")
            .replace(/&amp;/g, "&")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&quot;/g, '"')
            .replace(/[ \t]{2,}/g, " ")
            .replace(/\n{3,}/g, "\n\n")
            .trim();
          return stripped.slice(0, maxChars);
        } catch (err) {
          if ((err as Error).name === "AbortError") return "Error: request timed out (15s)";
          return `Error: ${formatError(err)}`;
        }
      }

      case "web_search": {
        const query = String(tool.arguments.query ?? "").trim();
        if (!query) return "Error: query is required";
        const apiKey = process.env.BRAVE_API_KEY?.trim();
        if (!apiKey) return "Error: BRAVE_API_KEY is not configured";
        const count = Math.min(Math.max((tool.arguments.count as number) ?? 5, 1), 10);
        const freshnessRaw = tool.arguments.freshness as string | undefined;
        const freshness = freshnessRaw && ["pd", "pw", "pm", "py"].includes(freshnessRaw)
          ? freshnessRaw as "pd" | "pw" | "pm" | "py"
          : undefined;
        try {
          const results = await braveWebSearch(query, apiKey, { count, freshness });
          if (results.length === 0) return "No web results found.";
          return results.map((result, index) => {
            const extra = result.extra_snippets?.slice(0, 2).join(" ") ?? "";
            const description = [result.description, extra].filter(Boolean).join(" ").trim();
            const summary = description.length > 280 ? `${description.slice(0, 277)}...` : description;
            const age = result.age ? ` (${result.age})` : "";
            return `[${index + 1}] ${result.title}${age}\n${result.url}\n${summary}`;
          }).join("\n\n").slice(0, maxOutput);
        } catch (err) {
          return `Error: ${formatError(err)}`;
        }
      }

      default:
        return `Unknown tool: ${tool.name}`;
    }
  } catch (err) {
    return `Error: ${formatError(err)}`;
  }
}
