import { describe, it, expect } from "bun:test";
import { formatSlackProposalBlocks } from "../channels/slack/interactive.js";

describe("formatSlackProposalBlocks", () => {
  const mockProposal = {
    id: 1,
    proposal_id: "prop-123",
    title: "Add retry logic to webhook handler",
    category: "feature",
    effort: "small",
    description: "Adds exponential backoff when webhook delivery fails",
    status: "proposed",
    proposed_by: "nyx",
    priority: "medium" as const,
    autonomy: "requires_approval" as const,
    created_at: Date.now(),
    updated_at: Date.now(),
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
    files_affected: ["src/channels/webhook.ts"],
  };

  it("builds blocks with title, description, and approve/reject buttons", () => {
    const blocks = formatSlackProposalBlocks(mockProposal as any);
    expect(blocks.length).toBeGreaterThanOrEqual(2);
    const actions = blocks.find((b: any) => b.type === "actions");
    expect(actions).toBeDefined();
    expect(actions.elements).toHaveLength(2);
    expect(actions.elements[0].action_id).toContain("prop-123");
    expect(actions.elements[0].style).toBe("primary");
    expect(actions.elements[1].style).toBe("danger");
  });

  it("handles proposal with no files", () => {
    const noFiles = { ...mockProposal, files_affected: [] };
    const blocks = formatSlackProposalBlocks(noFiles as any);
    const section = blocks.find((b: any) => b.type === "section");
    expect(section.text.text).toContain("none specified");
  });

  it("normalizes absolute file paths before rendering", () => {
    const withAbsolute = {
      ...mockProposal,
      files_affected: ["/home/user/dev/nyxhive/package.json"],
    };
    const blocks = formatSlackProposalBlocks(withAbsolute as any);
    const section = blocks.find((b: any) => b.type === "section");
    expect(section.text.text).toContain("nyxhive/package.json");
    expect(section.text.text).not.toContain("/home/user/dev/nyxhive");
  });
});
