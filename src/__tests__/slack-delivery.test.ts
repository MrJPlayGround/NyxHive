import { describe, it, expect, beforeEach } from "bun:test";
import {
  SlackDeliveryManager,
  inferPhase,
  activityDetail,
  _resetBuckets,
  type ApprovalRequestData,
  type InputRequestData,
  type ChangeSummaryData,
  type CompletionSummaryData,
  type FailureSummaryData,
} from "../channels/slack/delivery";

// ---------------------------------------------------------------------------
// Mock Slack client
// ---------------------------------------------------------------------------

interface MockCall {
  method: string;
  args: any;
}

function mockClient() {
  const calls: MockCall[] = [];
  let nextTs = 1000;

  return {
    calls,
    chat: {
      postMessage: async (args: any) => {
        calls.push({ method: "postMessage", args });
        return { ts: String(nextTs++), ok: true };
      },
      update: async (args: any) => {
        calls.push({ method: "update", args });
        return { ok: true };
      },
      delete: async (args: any) => {
        calls.push({ method: "delete", args });
        return { ok: true };
      },
    },
  };
}

// ---------------------------------------------------------------------------
// inferPhase
// ---------------------------------------------------------------------------

describe("inferPhase", () => {
  it("maps responding phase to completing", () => {
    expect(inferPhase("anything", "responding")).toBe("completing");
  });

  it("maps reading activity to planning", () => {
    expect(inferPhase("Reading invoke.ts", "working")).toBe("planning");
  });

  it("maps grep/search activity to planning", () => {
    expect(inferPhase("Searching for files", "working")).toBe("planning");
    expect(inferPhase("Glob **/*.ts", "working")).toBe("planning");
    expect(inferPhase("Grep pattern", "working")).toBe("planning");
  });

  it("maps bash/test activity to running_commands", () => {
    expect(inferPhase("Bash: bun test", "working")).toBe("running_commands");
    expect(inferPhase("Running tests", "working")).toBe("running_commands");
    expect(inferPhase("command: ls", "working")).toBe("running_commands");
  });

  it("maps edit/write activity to editing_files", () => {
    expect(inferPhase("Editing src/foo.ts", "working")).toBe("editing_files");
    expect(inferPhase("Write to config.json", "working")).toBe("editing_files");
    expect(inferPhase("Creating new file", "working")).toBe("editing_files");
    expect(inferPhase("Deleting old.ts", "working")).toBe("editing_files");
  });

  it("maps review/lint activity to reviewing", () => {
    expect(inferPhase("Reviewing changes", "working")).toBe("reviewing");
    expect(inferPhase("Lint check", "working")).toBe("reviewing");
  });

  it("defaults to planning for unknown activity", () => {
    expect(inferPhase("something else", "working")).toBe("planning");
  });

  it("defaults to planning when activity is undefined", () => {
    expect(inferPhase(undefined, "working")).toBe("planning");
  });
});

// ---------------------------------------------------------------------------
// activityDetail
// ---------------------------------------------------------------------------

describe("activityDetail", () => {
  it("returns undefined for undefined input", () => {
    expect(activityDetail(undefined)).toBeUndefined();
  });

  it("passes through short strings", () => {
    expect(activityDetail("Reading file.ts")).toBe("Nyx is checking context...");
  });

  it("truncates long strings", () => {
    const long = "A".repeat(200);
    const result = activityDetail(long);
    expect(result!.length).toBeLessThanOrEqual(100);
  });
});

// ---------------------------------------------------------------------------
// SlackDeliveryManager
// ---------------------------------------------------------------------------

describe("SlackDeliveryManager", () => {
  let client: ReturnType<typeof mockClient>;
  let delivery: SlackDeliveryManager;

  beforeEach(() => {
    _resetBuckets();
    client = mockClient();
    delivery = new SlackDeliveryManager({
      client,
      channelId: "C123",
      threadTs: "1234.5678",
      gatewayBaseUrl: "https://gateway.example.com",
    });
  });

  describe("updatePhase", () => {
    it("posts a new progress message on first call", async () => {
      await delivery.updatePhase("planning");
      expect(client.calls).toHaveLength(1);
      expect(client.calls[0].method).toBe("postMessage");
      expect(client.calls[0].args.channel).toBe("C123");
      expect(client.calls[0].args.thread_ts).toBe("1234.5678");
      expect(client.calls[0].args.text).toContain("Nyx is thinking");
    });

    it("edits the progress message on subsequent calls with different phase", async () => {
      await delivery.updatePhase("planning");
      // Wait past the debounce interval
      await new Promise((r) => setTimeout(r, 10));
      // Force a time gap by directly calling again
      await delivery.updatePhase("running_commands");
      expect(client.calls.length).toBeGreaterThanOrEqual(2);
      const updateCall = client.calls.find((c) => c.method === "update");
      if (updateCall) {
        expect(updateCall.args.text).toContain("Nyx is working");
      }
    });

    it("includes detail text when provided", async () => {
      await delivery.updatePhase("editing_files", "src/main.ts");
      expect(client.calls[0].args.text).toContain("Nyx is working");
      expect(client.calls[0].args.text).toContain("src/main.ts");
    });

    it("does not re-send identical progress text after the debounce window", async () => {
      await delivery.updatePhase("running_commands", "Running zsh");
      (delivery as any).lastUpdateMs -= 3000;

      await delivery.updatePhase("running_commands", "Running zsh");

      expect(client.calls).toHaveLength(1);
      expect(client.calls[0].method).toBe("postMessage");
    });
  });

  describe("postApprovalRequest", () => {
    it("posts a Block Kit approval card with approve/reject buttons", async () => {
      const data: ApprovalRequestData = {
        proposalId: "prop-123",
        title: "Add dark mode",
        description: "Implements theme switching",
        category: "feature",
        effort: "medium",
        filesAffected: ["src/theme.ts", "src/App.tsx"],
      };
      await delivery.postApprovalRequest(data);
      expect(client.calls).toHaveLength(1);
      expect(client.calls[0].method).toBe("postMessage");
      const blocks = client.calls[0].args.blocks;
      expect(blocks.length).toBeGreaterThanOrEqual(2);

      // Find actions block with buttons
      const actionsBlock = blocks.find((b: any) => b.type === "actions");
      expect(actionsBlock).toBeDefined();
      const buttons = actionsBlock.elements;
      expect(buttons).toHaveLength(2);
      expect(buttons[0].text.text).toBe("Approve");
      expect(buttons[1].text.text).toBe("Reject");
      expect(buttons[0].action_id).toContain("proposal_approve");
      expect(buttons[1].action_id).toContain("proposal_reject");

      // Text fallback for interactivity failure
      const contextBlock = blocks.find((b: any) => b.type === "context");
      expect(contextBlock).toBeDefined();
    });

    it("truncates long file lists", async () => {
      const files = Array.from({ length: 15 }, (_, i) => `src/file${i}.ts`);
      const data: ApprovalRequestData = {
        proposalId: "prop-456",
        title: "Big refactor",
        filesAffected: files,
      };
      await delivery.postApprovalRequest(data);
      const textBlock = client.calls[0].args.blocks[0];
      expect(textBlock.text.text).toContain("+5 more");
    });
  });

  describe("postInputRequest", () => {
    it("posts button choices for bounded decisions", async () => {
      const data: InputRequestData = {
        messageId: "msg-1",
        question: "Pick a strategy",
        options: [
          { key: "fast", description: "Fast" },
          { key: "thorough", description: "Thorough" },
        ],
      };
      await delivery.postInputRequest(data);
      const blocks = client.calls[0].args.blocks;
      const actionsBlock = blocks.find((b: any) => b.type === "actions");
      expect(actionsBlock).toBeDefined();
      expect(actionsBlock.elements).toHaveLength(2);
      expect(actionsBlock.elements[0].text.text).toBe("Fast");
      expect(actionsBlock.elements[0].action_id).toContain("msg-1");
    });

    it("posts text prompt for open input", async () => {
      const data: InputRequestData = {
        messageId: "msg-2",
        question: "What should the function be called?",
        options: [],
      };
      await delivery.postInputRequest(data);
      const blocks = client.calls[0].args.blocks;
      const ctxBlock = blocks.find((b: any) => b.type === "context");
      expect(ctxBlock).toBeDefined();
      expect(ctxBlock.elements[0].text).toContain("Reply in this thread");
    });

    it("falls back to the option key when no description is present", async () => {
      const data: InputRequestData = {
        messageId: "msg-3",
        question: "Pick one",
        options: [{ key: "ship_it" }],
      };
      await delivery.postInputRequest(data);
      const actionsBlock = client.calls[0].args.blocks.find((b: any) => b.type === "actions");
      expect(actionsBlock.elements[0].text.text).toBe("ship_it");
    });
  });

  describe("postChangeSummary", () => {
    it("posts a compact change summary with gateway link", async () => {
      const data: ChangeSummaryData = {
        files: [
          { path: "src/main.ts", added: 10, removed: 3 },
          { path: "src/utils.ts", added: 5, removed: 0 },
        ],
        summary: "Added validation",
        verified: true,
        threadId: "thread-abc",
      };
      await delivery.postChangeSummary(data);
      const blocks = client.calls[0].args.blocks;
      const text = blocks[0].text.text;
      expect(text).toContain("2 files changed");
      expect(text).toContain("+15 -3");
      expect(text).toContain("src/main.ts");
      expect(text).toContain("Verified");
      expect(text).toContain("gateway.example.com");
      expect(text).toContain("tab=changes");
    });

    it("truncates file lists beyond 10", async () => {
      const files = Array.from({ length: 12 }, (_, i) => ({
        path: `src/file${i}.ts`,
        added: 1,
        removed: 0,
      }));
      const data: ChangeSummaryData = { files, threadId: "t" };
      await delivery.postChangeSummary(data);
      const text = client.calls[0].args.blocks[0].text.text;
      expect(text).toContain("+2 more");
    });

    it("omits zero line counts and falls back to the operation label", async () => {
      const data: ChangeSummaryData = {
        files: [{ path: "/home/user/dev/nyxhive/package.json", added: 0, removed: 0, operation: "edit" }],
      };
      await delivery.postChangeSummary(data);
      const text = client.calls[0].args.blocks[0].text.text;
      expect(text).toContain("package.json");
      expect(text).toContain("(edit)");
      expect(text).not.toContain("+0 -0");
    });
  });

  describe("postCompletionSummary", () => {
    it("posts a completion card with gateway link and metadata", async () => {
      const data: CompletionSummaryData = {
        text: "Implemented the feature successfully.",
        agent: "nyx",
        durationMs: 15000,
        tokensIn: 5000,
        tokensOut: 2000,
        cost: 0.0123,
        threadId: "thread-xyz",
      };
      await delivery.postCompletionSummary(data);
      expect(client.calls.length).toBeGreaterThanOrEqual(1);
      const postCall = client.calls.find((c) => c.method === "postMessage");
      expect(postCall).toBeDefined();
      const blocks = postCall!.args.blocks;
      const mainText = blocks[0].text.text;
      expect(mainText).toContain("Done");
      expect(mainText).toContain("nyx");
      expect(mainText).toContain("Implemented the feature");

      // Check context block for metadata
      const ctxBlock = blocks.find((b: any) => b.type === "context");
      if (ctxBlock) {
        const meta = ctxBlock.elements[0].text;
        expect(meta).toContain("15.0s");
        expect(meta).toContain("gateway");
        expect(meta).not.toContain("tokens");
        expect(meta).not.toContain("$0.0123");
      }
    });

    it("deletes the progress message on completion", async () => {
      // First create a progress message
      await delivery.updatePhase("planning");
      // Then complete
      await delivery.postCompletionSummary({ text: "Done", threadId: "t" });
      const deleteCall = client.calls.find((c) => c.method === "delete");
      expect(deleteCall).toBeDefined();
    });
  });

  describe("postFailureSummary", () => {
    it("posts a failure card with error and gateway link", async () => {
      const data: FailureSummaryData = {
        error: "Timeout exceeded",
        threadId: "thread-err",
      };
      await delivery.postFailureSummary(data);
      const blocks = client.calls[0].args.blocks;
      const text = blocks[0].text.text;
      expect(text).toContain("Failed");
      expect(text).toContain("Timeout exceeded");
      expect(text).toContain("gateway.example.com");
    });

    it("deletes the progress message on failure", async () => {
      await delivery.updatePhase("running_commands");
      await delivery.postFailureSummary({ error: "oops", threadId: "t" });
      const deleteCall = client.calls.find((c) => c.method === "delete");
      expect(deleteCall).toBeDefined();
    });
  });

  describe("finalize", () => {
    it("deletes progress message if still present", async () => {
      await delivery.updatePhase("planning");
      await delivery.finalize();
      const deleteCall = client.calls.find((c) => c.method === "delete");
      expect(deleteCall).toBeDefined();
    });

    it("is a no-op when no progress message exists", async () => {
      await delivery.finalize();
      expect(client.calls).toHaveLength(0);
    });
  });

  describe("without gateway URL", () => {
    it("omits gateway links when gatewayBaseUrl is not set", async () => {
      const noGw = new SlackDeliveryManager({
        client,
        channelId: "C123",
        threadTs: "1234.5678",
      });
      await noGw.postCompletionSummary({ text: "Done", threadId: "t" });
      const blocks = client.calls[0].args.blocks;
      const allText = blocks.map((b: any) => {
        if (b.text?.text) return b.text.text;
        if (b.elements) return b.elements.map((e: any) => e.text).join(" ");
        return "";
      }).join(" ");
      expect(allText).not.toContain("gateway");
    });
  });
});
