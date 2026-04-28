import { describe, it, expect } from "bun:test";
import { createHmac } from "crypto";
import { GitHubSource } from "../channels/webhook-sources/github.js";
import type { WebhookSourceConfig } from "../channels/webhook-sources/types.js";

const SECRET = "test-secret-key";

function sign(body: string, secret: string = SECRET): string {
  const hmac = createHmac("sha256", secret);
  hmac.update(body);
  return `sha256=${hmac.digest("hex")}`;
}

const source = new GitHubSource();

const prPayload = {
  action: "opened",
  number: 42,
  pull_request: {
    title: "Fix auth token refresh",
    user: { login: "contributor" },
    html_url: "https://github.com/AgentNyxAI/nyxhive/pull/42",
    head: { ref: "feature/fix-auth-refresh" },
    base: { ref: "main" },
    changed_files: 3,
  },
  repository: { name: "nyxhive", full_name: "AgentNyxAI/nyxhive" },
};

const issuePayload = {
  action: "opened",
  issue: {
    number: 15,
    title: "Scheduler tasks don't respect timezone",
    user: { login: "user" },
    html_url: "https://github.com/AgentNyxAI/nyxhive/issues/15",
    labels: [{ name: "bug" }],
    body: "This is the issue body.",
  },
  repository: { name: "nyxhive" },
};

const commentPayload = {
  action: "created",
  issue: {
    number: 7,
    title: "Some issue",
  },
  comment: {
    user: { login: "commenter" },
    html_url: "https://github.com/AgentNyxAI/nyxhive/issues/7#issuecomment-123",
    body: "This is a comment.",
  },
  repository: { name: "nyxhive" },
};

const commentPayloadWithMention = {
  action: "created",
  issue: {
    number: 7,
    title: "Some issue",
  },
  comment: {
    user: { login: "commenter" },
    html_url: "https://github.com/AgentNyxAI/nyxhive/issues/7#issuecomment-456",
    body: "Hey @nyx can you look into this?",
  },
  repository: { name: "nyxhive", full_name: "AgentNyxAI/nyxhive" },
};

const prReopenedPayload = {
  action: "reopened",
  number: 42,
  pull_request: {
    title: "Fix auth token refresh",
    user: { login: "contributor" },
    html_url: "https://github.com/AgentNyxAI/nyxhive/pull/42",
    head: { ref: "feature/fix-auth-refresh" },
    base: { ref: "main" },
    changed_files: 3,
  },
  repository: { name: "nyxhive", full_name: "AgentNyxAI/nyxhive" },
};

describe("GitHubSource.verifySignature", () => {
  it("accepts a valid signature", () => {
    const body = JSON.stringify(prPayload);
    const sig = sign(body);
    expect(source.verifySignature(body, sig, SECRET)).toBe(true);
  });

  it("rejects an invalid signature", () => {
    const body = JSON.stringify(prPayload);
    const sig = sign(body, "wrong-secret");
    expect(source.verifySignature(body, sig, SECRET)).toBe(false);
  });

  it("rejects a signature missing the sha256= prefix", () => {
    const body = JSON.stringify(prPayload);
    const hmac = createHmac("sha256", SECRET);
    hmac.update(body);
    const rawHex = hmac.digest("hex");
    expect(source.verifySignature(body, rawHex, SECRET)).toBe(false);
  });

  it("rejects an empty signature", () => {
    const body = JSON.stringify(prPayload);
    expect(source.verifySignature(body, "", SECRET)).toBe(false);
  });

  it("rejects a tampered body", () => {
    const body = JSON.stringify(prPayload);
    const sig = sign(body);
    const tampered = body + "extra";
    expect(source.verifySignature(tampered, sig, SECRET)).toBe(false);
  });
});

describe("GitHubSource.parseEvent", () => {
  it("parses pull_request.opened", () => {
    const body = JSON.stringify(prPayload);
    const headers = {
      "x-github-event": "pull_request",
      "x-github-delivery": "abc-123",
    };
    const event = source.parseEvent(headers, body);
    expect(event).not.toBeNull();
    expect(event?.source).toBe("github");
    expect(event?.type).toBe("pull_request.opened");
    expect(event?.deliveryId).toBe("abc-123");
    expect(event?.payload).toMatchObject(prPayload);
  });

  it("parses issues.opened", () => {
    const body = JSON.stringify(issuePayload);
    const headers = {
      "x-github-event": "issues",
      "x-github-delivery": "def-456",
    };
    const event = source.parseEvent(headers, body);
    expect(event).not.toBeNull();
    expect(event?.type).toBe("issues.opened");
    expect(event?.deliveryId).toBe("def-456");
  });

  it("parses issue_comment.created", () => {
    const body = JSON.stringify(commentPayload);
    const headers = {
      "x-github-event": "issue_comment",
      "x-github-delivery": "ghi-789",
    };
    const event = source.parseEvent(headers, body);
    expect(event).not.toBeNull();
    expect(event?.type).toBe("issue_comment.created");
  });

  it("returns null for missing x-github-event header", () => {
    const body = JSON.stringify(prPayload);
    const headers = {
      "x-github-delivery": "abc-123",
    };
    const event = source.parseEvent(headers, body);
    expect(event).toBeNull();
  });

  it("returns null for invalid JSON body", () => {
    const headers = {
      "x-github-event": "pull_request",
      "x-github-delivery": "abc-123",
    };
    const event = source.parseEvent(headers, "not-json{{{");
    expect(event).toBeNull();
  });
});

describe("GitHubSource.mapToAction", () => {
  const config: WebhookSourceConfig = {
    secret_env: "GITHUB_WEBHOOK_SECRET",
    events: ["pull_request.opened", "pull_request.reopened", "issues.opened", "issue_comment.created"],
    agent: "nyx",
    repos: ["nyxhive"],
  };

  it("maps pull_request.opened to a review action", () => {
    const body = JSON.stringify(prPayload);
    const headers = { "x-github-event": "pull_request", "x-github-delivery": "abc-123" };
    const event = source.parseEvent(headers, body)!;
    const action = source.mapToAction(event, config);

    expect(action).not.toBeNull();
    expect(action?.channel).toBe("webhook");
    expect(action?.sender).toBe("github:pull_request.opened");
    expect(action?.agent).toBe("nyx");
    expect(action?.message).toContain("PR #42");
    expect(action?.message).toContain("Fix auth token refresh");
    expect(action?.message).toContain("contributor");
    expect(action?.message).toContain("https://github.com/AgentNyxAI/nyxhive/pull/42");
    expect(action?.message).toContain("feature/fix-auth-refresh");
    expect(action?.message).toContain("3");
  });

  it("maps issues.opened to a triage action", () => {
    const body = JSON.stringify(issuePayload);
    const headers = { "x-github-event": "issues", "x-github-delivery": "def-456" };
    const event = source.parseEvent(headers, body)!;
    const action = source.mapToAction(event, config);

    expect(action).not.toBeNull();
    expect(action?.channel).toBe("webhook");
    expect(action?.sender).toBe("github:issues.opened");
    expect(action?.message).toContain("Issue #15");
    expect(action?.message).toContain("Scheduler tasks don't respect timezone");
    expect(action?.message).toContain("user");
    expect(action?.message).toContain("https://github.com/AgentNyxAI/nyxhive/issues/15");
    expect(action?.message).toContain("bug");
  });

  it("returns null for an event not in config.events", () => {
    const configNoComment: WebhookSourceConfig = {
      secret_env: "GITHUB_WEBHOOK_SECRET",
      events: ["pull_request.opened"],
      agent: "nyx",
    };
    const body = JSON.stringify(commentPayload);
    const headers = { "x-github-event": "issue_comment", "x-github-delivery": "ghi-789" };
    const event = source.parseEvent(headers, body)!;
    const action = source.mapToAction(event, configNoComment);
    expect(action).toBeNull();
  });

  it("returns null for a repo not in config.repos", () => {
    const body = JSON.stringify(prPayload); // repo = "nyxhive"
    const headers = { "x-github-event": "pull_request", "x-github-delivery": "abc-123" };
    const event = source.parseEvent(headers, body)!;

    const restrictedConfig: WebhookSourceConfig = {
      secret_env: "GITHUB_WEBHOOK_SECRET",
      events: ["pull_request.opened"],
      agent: "nyx",
      repos: ["nyx-ios"], // nyxhive not allowed
    };
    const action = source.mapToAction(event, restrictedConfig);
    expect(action).toBeNull();
  });

  it("allows all repos when config.repos is empty", () => {
    const body = JSON.stringify(prPayload);
    const headers = { "x-github-event": "pull_request", "x-github-delivery": "abc-123" };
    const event = source.parseEvent(headers, body)!;

    const openConfig: WebhookSourceConfig = {
      secret_env: "GITHUB_WEBHOOK_SECRET",
      events: ["pull_request.opened"],
      agent: "nyx",
      repos: [], // empty = all
    };
    const action = source.mapToAction(event, openConfig);
    expect(action).not.toBeNull();
  });

  it("allows all repos when config.repos is undefined", () => {
    const body = JSON.stringify(prPayload);
    const headers = { "x-github-event": "pull_request", "x-github-delivery": "abc-124" };
    const event = source.parseEvent(headers, body)!;

    const openConfig: WebhookSourceConfig = {
      secret_env: "GITHUB_WEBHOOK_SECRET",
      events: ["pull_request.opened"],
      agent: "nyx",
      // repos: undefined — all repos allowed
    };
    const action = source.mapToAction(event, openConfig);
    expect(action).not.toBeNull();
  });

  it("maps issue_comment.created with @nyx mention to an action", () => {
    const body = JSON.stringify(commentPayloadWithMention);
    const headers = { "x-github-event": "issue_comment", "x-github-delivery": "zzz-001" };
    const event = source.parseEvent(headers, body)!;
    const action = source.mapToAction(event, config);
    expect(action).not.toBeNull();
    expect(action?.message).toContain("Hey @nyx can you look into this?");
  });

  it("returns null for issue_comment.created without bot mention", () => {
    const payload = {
      ...commentPayload,
      comment: { ...commentPayload.comment, body: "This comment has no mention at all." },
    };
    const body = JSON.stringify(payload);
    const headers = { "x-github-event": "issue_comment", "x-github-delivery": "zzz-002" };
    const event = source.parseEvent(headers, body)!;
    const action = source.mapToAction(event, config);
    expect(action).toBeNull();
  });

  it("allows repo filter match by full_name (AgentNyxAI/nyxhive)", () => {
    const body = JSON.stringify(prReopenedPayload);
    const headers = { "x-github-event": "pull_request", "x-github-delivery": "zzz-004" };
    const event = source.parseEvent(headers, body)!;

    const fullNameConfig: WebhookSourceConfig = {
      secret_env: "GITHUB_WEBHOOK_SECRET",
      events: ["pull_request.reopened"],
      agent: "nyx",
      repos: ["AgentNyxAI/nyxhive"], // only full_name, not short name
    };
    const action = source.mapToAction(event, fullNameConfig);
    expect(action).not.toBeNull();
  });

  it("maps pull_request.reopened to a review action", () => {
    const body = JSON.stringify(prReopenedPayload);
    const headers = { "x-github-event": "pull_request", "x-github-delivery": "zzz-005" };
    const event = source.parseEvent(headers, body)!;
    expect(event?.type).toBe("pull_request.reopened");
    const action = source.mapToAction(event, config);
    expect(action).not.toBeNull();
    expect(action?.sender).toBe("github:pull_request.reopened");
    expect(action?.message).toContain("PR #42");
  });
});
