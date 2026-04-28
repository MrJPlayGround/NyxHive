import { createHmac, timingSafeEqual } from "node:crypto";
import type { WebhookSource, WebhookEvent, WebhookAction, WebhookSourceConfig } from "./types.js";

/** Safely extract a string from a nested object path */
function str(obj: unknown, ...keys: string[]): string {
  let current: unknown = obj;
  for (const key of keys) {
    if (current == null || typeof current !== "object") return "unknown";
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "string" ? current : String(current ?? "unknown");
}

export class GitHubSource implements WebhookSource {
  name = "github";

  verifySignature(body: string, signature: string, secret: string): boolean {
    if (!signature || !signature.startsWith("sha256=")) {
      return false;
    }
    const provided = signature.slice("sha256=".length);
    if (!provided) {
      return false;
    }
    const hmac = createHmac("sha256", secret);
    hmac.update(body);
    const expected = hmac.digest("hex");

    try {
      return timingSafeEqual(Buffer.from(provided, "hex"), Buffer.from(expected, "hex"));
    } catch {
      return false;
    }
  }

  parseEvent(headers: Record<string, string>, body: string): WebhookEvent | null {
    const eventType = headers["x-github-event"];
    const deliveryId = headers["x-github-delivery"] ?? "";

    if (!eventType) {
      return null;
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(body) as Record<string, unknown>;
    } catch {
      return null;
    }

    const action = typeof payload.action === "string" ? payload.action : "";
    const type = action ? `${eventType}.${action}` : eventType;

    return {
      source: "github",
      type,
      deliveryId,
      payload,
      timestamp: Date.now(),
    };
  }

  mapToAction(event: WebhookEvent, config: WebhookSourceConfig): WebhookAction | null {
    if (!config.events.includes(event.type)) {
      return null;
    }

    const { name: repoName, fullName: repoFullName } = getRepo(event.payload);
    if (config.repos && config.repos.length > 0) {
      const allowed = config.repos.includes(repoName) || config.repos.includes(repoFullName);
      if (!allowed) {
        return null;
      }
    }

    if (event.type === "issue_comment.created") {
      const comment = event.payload.comment as Record<string, unknown> | undefined;
      const body = typeof comment?.body === "string" ? comment.body : "";
      const mentionedNyx = /@nyx/i.test(body);
      const mentionedAgent = config.agent ? new RegExp(`@${config.agent}`, "i").test(body) : false;
      if (!mentionedNyx && !mentionedAgent) {
        return null;
      }
    }

    const message = this.formatMessage(event);
    if (message === null) {
      return null;
    }

    return {
      channel: "webhook",
      sender: `github:${event.type}`,
      senderId: "webhook:github",
      message,
      agent: config.agent,
    };
  }

  private formatMessage(event: WebhookEvent): string | null {
    const p = event.payload;

    if (event.type === "pull_request.opened" || event.type === "pull_request.reopened") {
      const pr = p.pull_request as Record<string, unknown>;
      const { fullName: repo } = getRepo(p);
      const number = p.number ?? 0;
      const title = str(pr, "title");
      const author = str(pr, "user", "login");
      const url = str(pr, "html_url");
      const headRef = str(pr, "head", "ref");
      const baseRef = str(pr, "base", "ref");
      const filesChanged = pr.changed_files ?? 0;

      return [
        `[GitHub] PR #${number} opened in ${repo} by @${author}`,
        `Title: ${title}`,
        "",
        "Review this pull request. Check for:",
        "1. Code quality and correctness",
        "2. Test coverage",
        "3. Security implications",
        "4. Alignment with project conventions",
        "",
        `PR URL: ${url}`,
        `Branch: ${headRef} → ${baseRef}`,
        `Files changed: ${filesChanged}`,
      ].join("\n");
    }

    if (event.type === "issues.opened") {
      const issue = p.issue as Record<string, unknown>;
      const { fullName: repo } = getRepo(p);
      const number = issue.number ?? 0;
      const title = str(issue, "title");
      const author = str(issue, "user", "login");
      const url = str(issue, "html_url");
      const labels = ((issue.labels as Array<Record<string, unknown>>) ?? [])
        .map((l) => l.name as string)
        .join(", ");
      const body = typeof issue.body === "string" ? issue.body.slice(0, 1000) : "";

      const lines = [
        `[GitHub] Issue #${number} opened in ${repo} by @${author}`,
        `Title: ${title}`,
        "",
        "Triage this issue:",
        "1. Is this a real bug or user error?",
        "2. What's the severity/priority?",
        "3. Should we create a proposal for this? Use [@propose:] if so.",
        "",
        `Issue URL: ${url}`,
        `Labels: ${labels}`,
      ];
      if (body) {
        lines.push("", body);
      }
      return lines.join("\n");
    }

    if (event.type === "issue_comment.created") {
      const issue = p.issue as Record<string, unknown>;
      const comment = p.comment as Record<string, unknown>;
      const number = issue.number ?? 0;
      const issueTitle = str(issue, "title");
      const commentAuthor = str(comment, "user", "login");
      const url = str(comment, "html_url");
      const commentBody = typeof comment.body === "string" ? comment.body.slice(0, 2000) : "";

      return [
        `[GitHub] Comment on issue #${number} "${issueTitle}" by @${commentAuthor}`,
        "",
        `Comment URL: ${url}`,
        "",
        commentBody,
      ].join("\n");
    }

    return null;
  }
}

function getRepo(payload: Record<string, unknown>): { name: string; fullName: string } {
  const repo = payload.repository as Record<string, unknown> | undefined;
  const name = typeof repo?.name === "string" ? repo.name : "";
  const fullName = typeof repo?.full_name === "string" ? repo.full_name : name;
  return { name, fullName };
}
