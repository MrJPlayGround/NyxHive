import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verify Slack request signature.
 * https://api.slack.com/authentication/verifying-requests-from-slack
 */
export function verifySlackSignature(
  signingSecret: string,
  signature: string | null,
  timestamp: string | null,
  body: string,
): boolean {
  if (!signature || !timestamp) return false;

  // Reject requests older than 5 minutes
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(timestamp)) > 300) return false;

  const basestring = `v0:${timestamp}:${body}`;
  const hmac = createHmac("sha256", signingSecret).update(basestring).digest("hex");
  const expected = `v0=${hmac}`;

  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

/**
 * Parse Slack event payload and return event type + data.
 */
export function parseSlackPayload(body: any): {
  type: "url_verification" | "event" | "interaction" | "command" | "unknown";
  challenge?: string;
  event?: any;
  payload?: any;
} {
  if (body.type === "url_verification") {
    return { type: "url_verification", challenge: body.challenge };
  }
  if (body.type === "event_callback" && body.event) {
    return { type: "event", event: body.event };
  }
  return { type: "unknown", payload: body };
}
