/**
 * Proposal notification formatting for Discord and Telegram.
 * Provides rich formatting (embeds, inline keyboards) and plain text fallbacks.
 */

import type { Proposal } from "./store.js";

/** Short hex ID from full proposal_id (e.g. "proposal-a1b2c3d4" → "a1b2c3d4") */
export function shortId(proposal: Proposal): string {
  return proposal.proposal_id.replace("proposal-", "");
}

/** Priority badge for display */
function priorityBadge(priority: string): string {
  switch (priority) {
    case "high": return "[HIGH]";
    case "medium": return "[MED]";
    case "low": return "[LOW]";
    default: return `[${priority.toUpperCase()}]`;
  }
}

/**
 * Format a proposal as a plain-text notification (fallback for all channels).
 */
export function formatProposalPlainText(proposal: Proposal): string {
  const id = shortId(proposal);
  const lines: string[] = [
    `${priorityBadge(proposal.priority)} Proposal #${id}: ${proposal.title}`,
    `Category: ${proposal.category} | Effort: ${proposal.effort} | Priority: ${proposal.priority}`,
  ];
  if (proposal.files_affected.length > 0) {
    lines.push(`Files: ${proposal.files_affected.join(", ")}`);
  }
  lines.push("", proposal.description, "");
  lines.push(`Reply: "approve ${id}" or "reject ${id} <reason>"`);
  return lines.join("\n");
}

/**
 * Format a proposal as a Discord embed object.
 * Returns the embed data and action row for discord.js.
 */
export function formatDiscordEmbed(proposal: Proposal): {
  embed: {
    title: string;
    description: string;
    color: number;
    fields: Array<{ name: string; value: string; inline: boolean }>;
    footer: { text: string };
    timestamp: string;
  };
  buttons: Array<{
    customId: string;
    label: string;
    style: number; // 1=Primary, 2=Secondary, 3=Success, 4=Danger
  }>;
} {
  const id = shortId(proposal);
  const color = proposal.priority === "high" ? 0xff4444 : proposal.priority === "medium" ? 0xffaa00 : 0x44aa44;

  return {
    embed: {
      title: `Proposal #${id}: ${proposal.title}`,
      description: proposal.description.slice(0, 4096),
      color,
      fields: [
        { name: "Category", value: proposal.category, inline: true },
        { name: "Effort", value: proposal.effort, inline: true },
        { name: "Priority", value: proposal.priority, inline: true },
        ...(proposal.files_affected.length > 0
          ? [{ name: "Files", value: proposal.files_affected.join("\n").slice(0, 1024), inline: false }]
          : []),
        { name: "Proposed by", value: `@${proposal.proposed_by}`, inline: true },
      ],
      footer: { text: `proposal-${id}` },
      timestamp: new Date(proposal.created_at).toISOString(),
    },
    buttons: [
      { customId: `proposal:approve:${id}`, label: "Approve", style: 3 },
      { customId: `proposal:reject:${id}`, label: "Reject", style: 4 },
      { customId: `proposal:view:${id}`, label: "View Details", style: 2 },
    ],
  };
}

/**
 * Format a proposal for Telegram with inline keyboard data.
 * Returns markdown text and inline keyboard button definitions.
 */
export function formatTelegramNotification(proposal: Proposal): {
  text: string;
  inlineKeyboard: Array<Array<{ text: string; callback_data: string }>>;
} {
  const id = shortId(proposal);
  const priorityEmoji = proposal.priority === "high" ? "!" : proposal.priority === "medium" ? "-" : ".";
  const lines: string[] = [
    `${priorityEmoji} *Proposal #${id}*: ${escapeMarkdown(proposal.title)}`,
    "",
    escapeMarkdown(proposal.description),
    "",
    `*Category:* ${proposal.category}  |  *Effort:* ${proposal.effort}  |  *Priority:* ${proposal.priority}`,
  ];
  if (proposal.files_affected.length > 0) {
    lines.push(`*Files:* ${escapeMarkdown(proposal.files_affected.join(", "))}`);
  }
  lines.push(`*Proposed by:* @${proposal.proposed_by}`);

  return {
    text: lines.join("\n"),
    inlineKeyboard: [
      [
        { text: "Approve", callback_data: `proposal:approve:${id}` },
        { text: "Reject", callback_data: `proposal:reject:${id}` },
        { text: "View Details", callback_data: `proposal:view:${id}` },
      ],
    ],
  };
}

/**
 * Format a nudge reminder notification.
 */
export function formatNudgePlainText(proposal: Proposal): string {
  const id = shortId(proposal);
  const age = Math.floor((Date.now() - proposal.created_at) / (1000 * 60 * 60));
  return [
    `Reminder: Proposal #${id} is awaiting approval (${age}h old)`,
    `"${proposal.title}" — ${proposal.category}, ${proposal.effort} effort`,
    "",
    `Reply: "approve ${id}" or "reject ${id} <reason>"`,
  ].join("\n");
}

/** Escape Telegram MarkdownV1 special chars */
function escapeMarkdown(text: string): string {
  return text.replace(/([_[\]()~`>#+\-=|{}.!])/g, "\\$1");
}
