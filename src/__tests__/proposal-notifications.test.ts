import { describe, test, expect } from "bun:test";
import {
  shortId,
  formatProposalPlainText,
  formatDiscordEmbed,
  formatTelegramNotification,
  formatNudgePlainText,
} from "../proposals/notifications.js";
import type { Proposal } from "../proposals/store.js";

/** Helper to build a minimal Proposal for testing */
function makeProposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: 1,
    proposal_id: "proposal-a1b2c3d4",
    title: "Fix broken parser",
    description: "The parser fails on empty input.",
    category: "bugfix",
    autonomy: "requires_approval",
    status: "proposed",
    priority: "medium",
    effort: "small",
    files_affected: ["src/parser.ts"],
    thread_id: null,
    proposed_by: "scout",
    scout_source: null,
    approved_by: null,
    approved_at: null,
    rejection_reason: null,
    execution_ref: null,
    execution_result: null,
    executed_by: null,
    execution_trigger: null,
    review_result: null,
    reviewed_by: null,
    reviewed_at: null,
    verdict: null,
    review_count: 0,
    pr_url: null,
    pr_mergeable: null,
    merged_at: null,
    merged_by: null,
    nudged_at: null,
    expires_at: null,
    created_at: Date.now() - 1000 * 60 * 60 * 3, // 3 hours ago
    updated_at: Date.now(),
    ...overrides,
  };
}

// ─── shortId ──────────────────────────────────────────────────────────

describe("shortId", () => {
  test("strips proposal- prefix", () => {
    const p = makeProposal({ proposal_id: "proposal-deadbeef" });
    expect(shortId(p)).toBe("deadbeef");
  });

  test("returns full id when no prefix present", () => {
    const p = makeProposal({ proposal_id: "noprefix" });
    expect(shortId(p)).toBe("noprefix");
  });
});

// ─── formatProposalPlainText ──────────────────────────────────────────

describe("formatProposalPlainText", () => {
  test("includes priority badge, id, and title", () => {
    const p = makeProposal({ priority: "high", proposal_id: "proposal-abc123" });
    const text = formatProposalPlainText(p);
    expect(text).toContain("[HIGH]");
    expect(text).toContain("Proposal #abc123");
    expect(text).toContain(p.title);
  });

  test("includes category, effort, and priority fields", () => {
    const p = makeProposal({ category: "feature", effort: "large", priority: "low" });
    const text = formatProposalPlainText(p);
    expect(text).toContain("Category: feature");
    expect(text).toContain("Effort: large");
    expect(text).toContain("Priority: low");
  });

  test("includes files when present", () => {
    const p = makeProposal({ files_affected: ["a.ts", "b.ts"] });
    const text = formatProposalPlainText(p);
    expect(text).toContain("Files: a.ts, b.ts");
  });

  test("omits files line when no files affected", () => {
    const p = makeProposal({ files_affected: [] });
    const text = formatProposalPlainText(p);
    expect(text).not.toContain("Files:");
  });

  test("includes description", () => {
    const p = makeProposal({ description: "Detailed fix description." });
    const text = formatProposalPlainText(p);
    expect(text).toContain("Detailed fix description.");
  });

  test("includes approve/reject reply instructions", () => {
    const p = makeProposal({ proposal_id: "proposal-ff00ff" });
    const text = formatProposalPlainText(p);
    expect(text).toContain('approve ff00ff');
    expect(text).toContain('reject ff00ff');
  });

  test("medium priority shows [MED] badge", () => {
    const p = makeProposal({ priority: "medium" });
    const text = formatProposalPlainText(p);
    expect(text).toContain("[MED]");
  });

  test("low priority shows [LOW] badge", () => {
    const p = makeProposal({ priority: "low" });
    const text = formatProposalPlainText(p);
    expect(text).toContain("[LOW]");
  });
});

// ─── formatDiscordEmbed ────────────────────────────────────────────────

describe("formatDiscordEmbed", () => {
  test("embed title includes id and proposal title", () => {
    const p = makeProposal({ proposal_id: "proposal-d1d2d3d4" });
    const { embed } = formatDiscordEmbed(p);
    expect(embed.title).toBe(`Proposal #d1d2d3d4: ${p.title}`);
  });

  test("embed description is proposal description (truncated to 4096)", () => {
    const longDesc = "x".repeat(5000);
    const p = makeProposal({ description: longDesc });
    const { embed } = formatDiscordEmbed(p);
    expect(embed.description.length).toBe(4096);
  });

  test("high priority gets red color", () => {
    const p = makeProposal({ priority: "high" });
    const { embed } = formatDiscordEmbed(p);
    expect(embed.color).toBe(0xff4444);
  });

  test("medium priority gets amber color", () => {
    const p = makeProposal({ priority: "medium" });
    const { embed } = formatDiscordEmbed(p);
    expect(embed.color).toBe(0xffaa00);
  });

  test("low priority gets green color", () => {
    const p = makeProposal({ priority: "low" });
    const { embed } = formatDiscordEmbed(p);
    expect(embed.color).toBe(0x44aa44);
  });

  test("fields include category, effort, priority, and proposed_by", () => {
    const p = makeProposal({ category: "maintenance", effort: "medium", priority: "high", proposed_by: "forge" });
    const { embed } = formatDiscordEmbed(p);
    const fieldNames = embed.fields.map((f) => f.name);
    expect(fieldNames).toContain("Category");
    expect(fieldNames).toContain("Effort");
    expect(fieldNames).toContain("Priority");
    expect(fieldNames).toContain("Proposed by");
    expect(embed.fields.find((f) => f.name === "Proposed by")!.value).toBe("@forge");
  });

  test("files field included when files present", () => {
    const p = makeProposal({ files_affected: ["src/a.ts", "src/b.ts"] });
    const { embed } = formatDiscordEmbed(p);
    const filesField = embed.fields.find((f) => f.name === "Files");
    expect(filesField).toBeTruthy();
    expect(filesField!.value).toContain("src/a.ts");
    expect(filesField!.inline).toBe(false);
  });

  test("files field omitted when no files", () => {
    const p = makeProposal({ files_affected: [] });
    const { embed } = formatDiscordEmbed(p);
    const filesField = embed.fields.find((f) => f.name === "Files");
    expect(filesField).toBeUndefined();
  });

  test("files field truncated to 1024 chars", () => {
    const longFiles = Array.from({ length: 200 }, (_, i) => `src/really/long/path/to/file${i}.ts`);
    const p = makeProposal({ files_affected: longFiles });
    const { embed } = formatDiscordEmbed(p);
    const filesField = embed.fields.find((f) => f.name === "Files")!;
    expect(filesField.value.length).toBeLessThanOrEqual(1024);
  });

  test("footer contains full proposal id", () => {
    const p = makeProposal({ proposal_id: "proposal-deadbeef" });
    const { embed } = formatDiscordEmbed(p);
    expect(embed.footer.text).toBe("proposal-deadbeef");
  });

  test("timestamp is ISO string of created_at", () => {
    const ts = 1709424000000; // fixed timestamp
    const p = makeProposal({ created_at: ts });
    const { embed } = formatDiscordEmbed(p);
    expect(embed.timestamp).toBe(new Date(ts).toISOString());
  });

  test("approve button has correct customId and style 3 (Success)", () => {
    const p = makeProposal({ proposal_id: "proposal-abc" });
    const { buttons } = formatDiscordEmbed(p);
    const approveBtn = buttons.find((b) => b.label === "Approve")!;
    expect(approveBtn.customId).toBe("proposal:approve:abc");
    expect(approveBtn.style).toBe(3);
  });

  test("reject button has correct customId and style 4 (Danger)", () => {
    const p = makeProposal({ proposal_id: "proposal-abc" });
    const { buttons } = formatDiscordEmbed(p);
    const rejectBtn = buttons.find((b) => b.label === "Reject")!;
    expect(rejectBtn.customId).toBe("proposal:reject:abc");
    expect(rejectBtn.style).toBe(4);
  });

  test("view details button has correct customId and secondary style", () => {
    const p = makeProposal({ proposal_id: "proposal-abc" });
    const { buttons } = formatDiscordEmbed(p);
    const detailsBtn = buttons.find((b) => b.label === "View Details")!;
    expect(detailsBtn.customId).toBe("proposal:view:abc");
    expect(detailsBtn.style).toBe(2);
  });
});

// ─── formatTelegramNotification ────────────────────────────────────────

describe("formatTelegramNotification", () => {
  test("high priority uses ! emoji marker", () => {
    const p = makeProposal({ priority: "high" });
    const { text } = formatTelegramNotification(p);
    expect(text.startsWith("!")).toBe(true);
  });

  test("medium priority uses - marker", () => {
    const p = makeProposal({ priority: "medium" });
    const { text } = formatTelegramNotification(p);
    expect(text.startsWith("-")).toBe(true);
  });

  test("low priority uses . marker", () => {
    const p = makeProposal({ priority: "low" });
    const { text } = formatTelegramNotification(p);
    expect(text.startsWith(".")).toBe(true);
  });

  test("title is bold markdown and includes short id", () => {
    const p = makeProposal({ proposal_id: "proposal-t1t2t3" });
    const { text } = formatTelegramNotification(p);
    expect(text).toContain("*Proposal #t1t2t3*");
  });

  test("escapes markdown special characters in title", () => {
    const p = makeProposal({ title: "Fix [parser] (v2)" });
    const { text } = formatTelegramNotification(p);
    expect(text).toContain("Fix \\[parser\\] \\(v2\\)");
  });

  test("escapes markdown special characters in description", () => {
    const p = makeProposal({ description: "Use `backticks` and _underscores_" });
    const { text } = formatTelegramNotification(p);
    expect(text).toContain("Use \\`backticks\\` and \\_underscores\\_");
  });

  test("includes category, effort, and priority fields in bold", () => {
    const p = makeProposal({ category: "feature", effort: "large", priority: "high" });
    const { text } = formatTelegramNotification(p);
    expect(text).toContain("*Category:* feature");
    expect(text).toContain("*Effort:* large");
    expect(text).toContain("*Priority:* high");
  });

  test("includes files when present", () => {
    const p = makeProposal({ files_affected: ["src/x.ts"] });
    const { text } = formatTelegramNotification(p);
    expect(text).toContain("*Files:* src/x\\.ts");
  });

  test("omits files when empty", () => {
    const p = makeProposal({ files_affected: [] });
    const { text } = formatTelegramNotification(p);
    expect(text).not.toContain("*Files:*");
  });

  test("includes proposed_by", () => {
    const p = makeProposal({ proposed_by: "scout" });
    const { text } = formatTelegramNotification(p);
    expect(text).toContain("*Proposed by:* @scout");
  });

  test("inline keyboard has approve, reject, and details buttons", () => {
    const p = makeProposal({ proposal_id: "proposal-ik01" });
    const { inlineKeyboard } = formatTelegramNotification(p);
    expect(inlineKeyboard).toHaveLength(1);
    expect(inlineKeyboard[0]).toHaveLength(3);
    expect(inlineKeyboard[0][0]).toEqual({ text: "Approve", callback_data: "proposal:approve:ik01" });
    expect(inlineKeyboard[0][1]).toEqual({ text: "Reject", callback_data: "proposal:reject:ik01" });
    expect(inlineKeyboard[0][2]).toEqual({ text: "View Details", callback_data: "proposal:view:ik01" });
  });
});

// ─── formatNudgePlainText ──────────────────────────────────────────────

describe("formatNudgePlainText", () => {
  test("includes proposal id and age in hours", () => {
    const threeHoursAgo = Date.now() - 1000 * 60 * 60 * 3;
    const p = makeProposal({ proposal_id: "proposal-nudge1", created_at: threeHoursAgo });
    const text = formatNudgePlainText(p);
    expect(text).toContain("Proposal #nudge1");
    expect(text).toContain("3h old");
  });

  test("includes title, category, and effort", () => {
    const p = makeProposal({ title: "Upgrade deps", category: "maintenance", effort: "medium" });
    const text = formatNudgePlainText(p);
    expect(text).toContain('"Upgrade deps"');
    expect(text).toContain("maintenance");
    expect(text).toContain("medium effort");
  });

  test("includes approve/reject instructions", () => {
    const p = makeProposal({ proposal_id: "proposal-nudge2" });
    const text = formatNudgePlainText(p);
    expect(text).toContain('approve nudge2');
    expect(text).toContain('reject nudge2');
  });

  test("age rounds down to whole hours", () => {
    // 2.9 hours ago should show 2h
    const almostThreeHours = Date.now() - 1000 * 60 * 60 * 2.9;
    const p = makeProposal({ created_at: almostThreeHours });
    const text = formatNudgePlainText(p);
    expect(text).toContain("2h old");
  });

  test("zero hours for very recent proposals", () => {
    const p = makeProposal({ created_at: Date.now() - 1000 * 30 }); // 30 seconds ago
    const text = formatNudgePlainText(p);
    expect(text).toContain("0h old");
  });
});
