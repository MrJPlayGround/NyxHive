/**
 * Terminal markdown renderer — picocolors-based.
 * Handles code blocks, headings, bold/italic, lists, blockquotes, inline code.
 */
import pc from "picocolors";

const TERM_WIDTH = () => process.stdout.columns || 80;

function wrap(text: string, width: number, indent = 0): string {
  const prefix = " ".repeat(indent);
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    if (!word) continue;
    if (current.length === 0) {
      current = word;
    } else if (current.length + 1 + word.length <= width - indent) {
      current += " " + word;
    } else {
      lines.push(prefix + current);
      current = word;
    }
  }
  if (current) lines.push(prefix + current);
  return lines.join("\n");
}

function renderInline(text: string): string {
  // Bold: **text** or __text__
  text = text.replace(/\*\*(.+?)\*\*/g, (_, t) => pc.bold(t));
  text = text.replace(/__(.+?)__/g, (_, t) => pc.bold(t));
  // Italic: *text* or _text_
  text = text.replace(/\*([^*]+?)\*/g, (_, t) => pc.italic ? pc.italic(t) : pc.dim(t));
  text = text.replace(/_([^_]+?)_/g, (_, t) => pc.dim(t));
  // Inline code: `code`
  text = text.replace(/`([^`]+?)`/g, (_, t) => pc.bgBlack(pc.cyan(` ${t} `)));
  return text;
}

export function renderMarkdown(text: string): string {
  const width = TERM_WIDTH();
  const lines = text.split("\n");
  const output: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    // Fenced code block
    if (line.trim().startsWith("```")) {
      const lang = line.trim().slice(3).trim();
      const border = pc.dim("  " + "─".repeat(Math.min(width - 4, 60)));
      output.push(border);
      if (lang) output.push(`  ${pc.dim(pc.bold(lang))}`);
      i++;
      while (i < lines.length && !lines[i]!.trim().startsWith("```")) {
        output.push(pc.cyan("  " + (lines[i] ?? "")));
        i++;
      }
      output.push(border);
      i++; // skip closing ```
      continue;
    }

    // ATX Headings
    const h1 = line.match(/^# (.+)/);
    const h2 = line.match(/^## (.+)/);
    const h3 = line.match(/^### (.+)/);

    if (h1) {
      output.push("");
      output.push(pc.bold(pc.white("  " + h1[1])));
      output.push(pc.dim("  " + "━".repeat(Math.min((h1[1] ?? "").length + 2, width - 4))));
      i++;
      continue;
    }
    if (h2) {
      output.push("");
      output.push(pc.bold("  " + h2[1]));
      i++;
      continue;
    }
    if (h3) {
      output.push(pc.bold(pc.dim("  " + h3[1])));
      i++;
      continue;
    }

    // Blockquote
    if (line.startsWith("> ")) {
      const content = renderInline(line.slice(2));
      output.push(pc.dim("  │ ") + pc.dim(content));
      i++;
      continue;
    }

    // Horizontal rule
    if (line.match(/^---+$/) || line.match(/^\*\*\*+$/)) {
      output.push(pc.dim("  " + "─".repeat(Math.min(width - 4, 60))));
      i++;
      continue;
    }

    // Unordered list
    const ul = line.match(/^(\s*)[*\-+] (.+)/);
    if (ul) {
      const depth = Math.floor((ul[1] ?? "").length / 2);
      const bullet = depth === 0 ? pc.dim("  •") : pc.dim("    ◦");
      const content = renderInline(ul[2] ?? "");
      output.push(`${bullet} ${content}`);
      i++;
      continue;
    }

    // Ordered list
    const ol = line.match(/^(\s*)\d+\. (.+)/);
    if (ol) {
      const num = line.match(/(\d+)\./)?.[1] ?? "1";
      const content = renderInline(ol[2] ?? "");
      output.push(`  ${pc.dim(num + ".")} ${content}`);
      i++;
      continue;
    }

    // Empty line
    if (line.trim() === "") {
      output.push("");
      i++;
      continue;
    }

    // Normal paragraph — wrap + inline render
    const rendered = renderInline(line);
    const wrapped = wrap(rendered, width, 2);
    output.push(wrapped);
    i++;
  }

  return output.join("\n").replace(/\n{3,}/g, "\n\n");
}

export function renderMarkdownLines(text: string, width?: number): string[] {
  const originalWidth = process.stdout.columns;
  if (typeof width === "number" && Number.isFinite(width) && width > 0) {
    try {
      Object.defineProperty(process.stdout, "columns", {
        configurable: true,
        value: width,
      });
    } catch {
      // Ignore width override failures and fall back to the current terminal width.
    }
  }

  try {
    return renderMarkdown(text).split("\n");
  } finally {
    if (typeof width === "number" && Number.isFinite(width) && width > 0) {
      try {
        Object.defineProperty(process.stdout, "columns", {
          configurable: true,
          value: originalWidth,
        });
      } catch {
        // Ignore restore failures; this helper only affects terminal presentation.
      }
    }
  }
}
