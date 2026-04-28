import { randomUUID } from "node:crypto";
import type { Proposal } from "../../proposals/store.js";
import { toRelativePath } from "../../utils/paths.js";

export interface InteractiveOption {
  label: string;
  value: string;
}

export interface InteractiveDirective {
  type: "buttons" | "select";
  placeholder?: string;
  options: InteractiveOption[];
}

export interface ParseResult {
  cleanText: string;
  directives: InteractiveDirective[];
}

const BUTTON_RE = /\[\[slack_buttons:\s*(.+?)\]\]/g;
const SELECT_RE = /\[\[slack_select:\s*(.+?)\]\]/g;

function parseOptions(raw: string): InteractiveOption[] {
  return raw.split(",").map((part) => {
    const trimmed = part.trim();
    const colonIdx = trimmed.lastIndexOf(":");
    if (colonIdx <= 0) return { label: trimmed, value: trimmed.toLowerCase().replace(/\s+/g, "_") };
    return {
      label: trimmed.slice(0, colonIdx).trim(),
      value: trimmed.slice(colonIdx + 1).trim(),
    };
  });
}

export function parseInteractiveDirectives(text: string): ParseResult {
  const directives: InteractiveDirective[] = [];
  let cleanText = text;

  for (const match of text.matchAll(BUTTON_RE)) {
    directives.push({ type: "buttons", options: parseOptions(match[1]) });
    cleanText = cleanText.replace(match[0], "");
  }

  for (const match of text.matchAll(SELECT_RE)) {
    const raw = match[1];
    const pipeIdx = raw.indexOf("|");
    if (pipeIdx > 0) {
      directives.push({
        type: "select",
        placeholder: raw.slice(0, pipeIdx).trim(),
        options: parseOptions(raw.slice(pipeIdx + 1)),
      });
    } else {
      directives.push({ type: "select", options: parseOptions(raw) });
    }
    cleanText = cleanText.replace(match[0], "");
  }

  return { cleanText: cleanText.trim(), directives };
}

// Opaque token store — maps tokens to original values. TTL 1h, max 10k entries.
const tokenStore = new Map<string, { value: string; expires: number }>();
const TOKEN_TTL_MS = 60 * 60 * 1000;
const TOKEN_MAX = 10_000;

function mintToken(value: string): string {
  const token = randomUUID().slice(0, 12);
  if (tokenStore.size >= TOKEN_MAX) {
    const now = Date.now();
    for (const [k, v] of tokenStore) {
      if (v.expires < now) tokenStore.delete(k);
    }
    if (tokenStore.size >= TOKEN_MAX) {
      let count = 0;
      for (const k of tokenStore.keys()) {
        tokenStore.delete(k);
        if (++count >= 1000) break;
      }
    }
  }
  tokenStore.set(token, { value, expires: Date.now() + TOKEN_TTL_MS });
  return token;
}

export function resolveToken(token: string): string | null {
  const entry = tokenStore.get(token);
  if (!entry) return null;
  if (entry.expires < Date.now()) {
    tokenStore.delete(token);
    return null;
  }
  return entry.value;
}

export function buildBlockKitBlocks(
  text: string,
  directives: InteractiveDirective[],
  callbackId: string,
): any[] {
  const blocks: any[] = [];

  if (text) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text } });
  }

  for (const directive of directives) {
    if (directive.type === "buttons") {
      blocks.push({
        type: "actions",
        elements: directive.options.map((opt) => {
          const token = mintToken(opt.value);
          return {
            type: "button",
            text: { type: "plain_text", text: opt.label },
            action_id: `nyxhive:reply_button:${callbackId}:${token}`,
            value: token,
          };
        }),
      });
    } else if (directive.type === "select") {
      blocks.push({
        type: "actions",
        elements: [{
          type: "static_select",
          placeholder: {
            type: "plain_text",
            text: directive.placeholder ?? "Choose...",
          },
          action_id: `nyxhive:reply_select:${callbackId}:${randomUUID().slice(0, 8)}`,
          options: directive.options.map((opt) => ({
            text: { type: "plain_text", text: opt.label },
            value: mintToken(opt.value),
          })),
        }],
      });
    }
  }

  return blocks;
}

export function formatSlackProposalBlocks(proposal: Proposal): any[] {
  const statusEmoji = proposal.status === "proposed" ? ":sparkles:" : ":arrows_counterclockwise:";
  const effortLabel = proposal.effort ?? "unknown";
  const fileList = proposal.files_affected?.length
    ? proposal.files_affected.map(f => `\`${toRelativePath(f)}\``).join(", ")
    : "none specified";

  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${statusEmoji} *Proposal: ${proposal.title}*\n` +
          `Category: \`${proposal.category}\` | Effort: \`${effortLabel}\` | Agent: \`${proposal.proposed_by}\`\n` +
          `Files: ${fileList}\n\n${proposal.description ?? ""}`,
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Approve" },
          style: "primary",
          action_id: `nyxhive:proposal_approve:${proposal.proposal_id}`,
          value: proposal.proposal_id,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Reject" },
          style: "danger",
          action_id: `nyxhive:proposal_reject:${proposal.proposal_id}`,
          value: proposal.proposal_id,
        },
      ],
    },
  ];
}
