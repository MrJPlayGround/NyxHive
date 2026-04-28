import { sanitizeAssistantResponse } from "../chat/response-sanitizer.js";

export function sanitizeResponse(text: string): string {
  return sanitizeAssistantResponse(text);
}

/**
 * Convert standard markdown to Slack mrkdwn format.
 *
 * Handles: bold, italic, strikethrough, headings, links, images, HR.
 * Leaves code blocks, inline code, blockquotes, and lists as-is (Slack handles them natively).
 */
export function markdownToSlack(md: string): string {
  // Protect code blocks from transformation
  const codeBlocks: string[] = [];
  let text = md.replace(/```[\s\S]*?```/g, (match) => {
    codeBlocks.push(match);
    return `\x00CB${codeBlocks.length - 1}\x00`;
  });

  // Markdown tables → preformatted blocks (Slack has no table support)
  // Must run before inline code protection so backticks in cells are handled
  text = text.replace(/(?:^(\|.+\|)\n(\|[-| :]+\|)\n((?:\|.+\|\n?)+))/gm, (_match, header: string, _sep: string, body: string) => {
    // Strip backticks from cells — the whole table becomes a code block
    const stripTicks = (s: string) => s.replace(/`/g, "");
    const parseRow = (row: string) => row.split("|").slice(1, -1).map((c: string) => stripTicks(c.trim()));
    const headers = parseRow(header);
    const rows = body.trim().split("\n").map(parseRow);

    // Calculate column widths
    const widths = headers.map((h: string, i: number) =>
      Math.max(h.length, ...rows.map((r: string[]) => (r[i] || "").length)),
    );

    const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - s.length));
    const formatRow = (cells: string[]) => cells.map((c, i) => pad(c, widths[i])).join("  ");
    const sep = widths.map((w: number) => "─".repeat(w)).join("──");

    const lines = [formatRow(headers), sep, ...rows.map(formatRow)];
    return `\`\`\`\n${lines.join("\n")}\n\`\`\``;
  });

  // Protect inline code
  const inlineCode: string[] = [];
  text = text.replace(/`[^`]+`/g, (match) => {
    inlineCode.push(match);
    return `\x00IC${inlineCode.length - 1}\x00`;
  });

  // Headings → bold (Slack has no heading support)
  text = text.replace(/^#{1,6}\s+(.+)$/gm, "*$1*");

  // Images ![alt](url) → <url|alt> (before links, since images contain link syntax)
  text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, "<$2|$1>");

  // Links [text](url) → <url|text>
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>");

  // Bold **text** or __text__ → *text* (must come before italic)
  text = text.replace(/\*\*(.+?)\*\*/g, "*$1*");
  text = text.replace(/__(.+?)__/g, "*$1*");

  // Italic *text* (single) — already valid in Slack mrkdwn, leave as-is
  // But _text_ is also valid, leave as-is

  // Strikethrough ~~text~~ → ~text~
  text = text.replace(/~~(.+?)~~/g, "~$1~");

  // Horizontal rules --- or *** or ___ → divider-like separator
  text = text.replace(/^[-*_]{3,}$/gm, "───────────────────");

  // Restore inline code
  text = text.replace(/\x00IC(\d+)\x00/g, (_, i) => inlineCode[Number(i)]);

  // Restore code blocks
  text = text.replace(/\x00CB(\d+)\x00/g, (_, i) => codeBlocks[Number(i)]);

  return text;
}

/**
 * Convert standard markdown to Telegram HTML format.
 *
 * Handles: bold, italic, strikethrough, headings, code blocks, inline code, links.
 * Telegram HTML supports: <b>, <i>, <s>, <code>, <pre>, <a href="">.
 */
export function markdownToTelegramHTML(md: string): string {
  // First, escape HTML entities in the raw text
  let text = md
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  // Protect code blocks from transformation
  const codeBlocks: string[] = [];
  text = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_match, lang, code) => {
    const block = lang ? `<pre><code class="language-${lang}">${code.trimEnd()}</code></pre>` : `<pre>${code.trimEnd()}</pre>`;
    codeBlocks.push(block);
    return `\x00CB${codeBlocks.length - 1}\x00`;
  });

  // Protect inline code
  const inlineCode: string[] = [];
  text = text.replace(/`([^`]+)`/g, (_match, code) => {
    inlineCode.push(`<code>${code}</code>`);
    return `\x00IC${inlineCode.length - 1}\x00`;
  });

  // Headings → bold (Telegram has no heading support)
  text = text.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");

  // Links [text](url)
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // Bold **text** or __text__ (must come before italic)
  text = text.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  text = text.replace(/__(.+?)__/g, "<b>$1</b>");

  // Italic *text* or _text_ (single)
  text = text.replace(/(?<!\w)\*([^*]+?)\*(?!\w)/g, "<i>$1</i>");
  text = text.replace(/(?<!\w)_([^_]+?)_(?!\w)/g, "<i>$1</i>");

  // Strikethrough ~~text~~
  text = text.replace(/~~(.+?)~~/g, "<s>$1</s>");

  // Horizontal rules
  text = text.replace(/^[-*_]{3,}$/gm, "───────────────────");

  // Restore inline code
  text = text.replace(/\x00IC(\d+)\x00/g, (_, i) => inlineCode[Number(i)]);

  // Restore code blocks
  text = text.replace(/\x00CB(\d+)\x00/g, (_, i) => codeBlocks[Number(i)]);

  return text;
}

interface TelegramHTMLTagState {
  name: string;
  openTag: string;
  closeTag: string;
}

interface TelegramHTMLPiece {
  type: "tag" | "text";
  value: string;
  name?: string;
  closing?: boolean;
}

function tokenizeTelegramHTML(html: string): TelegramHTMLPiece[] {
  const pieces: TelegramHTMLPiece[] = [];
  const segments = html.split(/(<\/?[^>]+>)/g).filter(Boolean);

  for (const segment of segments) {
    if (segment.startsWith("<") && segment.endsWith(">")) {
      const match = segment.match(/^<\/?([a-z0-9]+)(?:\s+[^>]+)?>$/i);
      if (match) {
        pieces.push({
          type: "tag",
          value: segment,
          name: match[1]!.toLowerCase(),
          closing: segment[1] === "/",
        });
        continue;
      }
    }

    const textParts = segment.match(/&(?:[a-z]+|#\d+|#x[\da-f]+);|[^\s&]+|\s+/gi) ?? [segment];
    for (const textPart of textParts) {
      if (textPart) {
        pieces.push({ type: "text", value: textPart });
      }
    }
  }

  return pieces;
}

function applyTelegramHTMLTag(
  stack: TelegramHTMLTagState[],
  piece: TelegramHTMLPiece,
): TelegramHTMLTagState[] {
  if (piece.type !== "tag" || !piece.name) return stack;

  if (!piece.closing) {
    return [
      ...stack,
      {
        name: piece.name,
        openTag: piece.value,
        closeTag: `</${piece.name}>`,
      },
    ];
  }

  const next = stack.slice();
  for (let i = next.length - 1; i >= 0; i--) {
    if (next[i]?.name === piece.name) {
      next.splice(i, 1);
      break;
    }
  }
  return next;
}

function buildTelegramHTMLClosers(stack: TelegramHTMLTagState[]): string {
  return stack
    .slice()
    .reverse()
    .map((tag) => tag.closeTag)
    .join("");
}

function splitTelegramHTMLTextPiece(text: string, maxLen: number): [string, string] {
  if (maxLen <= 0 || text.length <= maxLen) {
    return maxLen <= 0 ? ["", text] : [text, ""];
  }

  if (/^&(?:[a-z]+|#\d+|#x[\da-f]+);$/i.test(text)) {
    return ["", text];
  }

  return [text.slice(0, maxLen), text.slice(maxLen)];
}

export function splitTelegramHTML(html: string, maxLen: number): string[] {
  if (!html) return [];

  const pieces = tokenizeTelegramHTML(html);
  if (pieces.length === 0) return [];

  const chunks: string[] = [];
  let openTags: TelegramHTMLTagState[] = [];
  let index = 0;

  while (index < pieces.length) {
    const prefix = openTags.map((tag) => tag.openTag).join("");
    let body = "";
    let localOpenTags = openTags.slice();
    let appended = false;

    while (index < pieces.length) {
      const piece = pieces[index]!;
      const nextOpenTags = piece.type === "tag" ? applyTelegramHTMLTag(localOpenTags, piece) : localOpenTags;
      const nextLen = prefix.length + body.length + piece.value.length + buildTelegramHTMLClosers(nextOpenTags).length;

      if (nextLen <= maxLen) {
        body += piece.value;
        localOpenTags = nextOpenTags;
        index++;
        appended = true;
        continue;
      }

      if (piece.type === "text") {
        const available = maxLen - prefix.length - body.length - buildTelegramHTMLClosers(nextOpenTags).length;
        const [head, tail] = splitTelegramHTMLTextPiece(piece.value, available);
        if (head) {
          body += head;
          pieces[index] = { ...piece, value: tail };
          appended = true;
          break;
        }
      }

      if (!appended) {
        throw new Error(`Telegram HTML chunking failed for maxLen=${maxLen}`);
      }
      break;
    }

    if (!appended) break;

    chunks.push(`${prefix}${body}${buildTelegramHTMLClosers(localOpenTags)}`);
    openTags = localOpenTags;
  }

  return chunks;
}

export function buildTelegramHTMLPreview(
  html: string,
  maxLen: number,
  suffix = "\n\n<i>(full response attached)</i>",
): string {
  if (html.length <= maxLen) return html;
  const previewLimit = Math.max(1, maxLen - suffix.length);
  const preview = splitTelegramHTML(html, previewLimit)[0] ?? html.slice(0, previewLimit);
  return `${preview}${suffix}`;
}

// Threshold: if response exceeds this, send as file instead of splitting
const FILE_ATTACHMENT_THRESHOLD = 4000;

export function shouldSendAsFile(text: string, channelMaxLen: number): boolean {
  // Send as file if response is >2x the channel limit
  // Short overflows (e.g., 2100 chars on Discord) split fine — only use files for truly long responses
  return text.length > Math.max(FILE_ATTACHMENT_THRESHOLD, channelMaxLen * 2);
}

export function createResponseBuffer(text: string): Buffer {
  return Buffer.from(text, "utf-8");
}

export function splitMessage(text: string, maxLen: number): string[] {
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    let splitIdx = remaining.lastIndexOf("\n", maxLen);
    if (splitIdx < maxLen * 0.5) {
      splitIdx = remaining.lastIndexOf(" ", maxLen);
    }
    if (splitIdx < maxLen * 0.3) {
      splitIdx = maxLen;
    }

    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).trimStart();
  }

  return chunks;
}
