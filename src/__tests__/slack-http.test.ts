import { describe, it, expect } from "bun:test";
import { verifySlackSignature, parseSlackPayload } from "../channels/slack/http-handler.js";

describe("verifySlackSignature", () => {
  const secret = "test_signing_secret";

  it("verifies valid signature", () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = '{"type":"url_verification"}';
    const { createHmac } = require("crypto");
    const hmac = createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex");
    const signature = `v0=${hmac}`;
    expect(verifySlackSignature(secret, signature, timestamp, body)).toBe(true);
  });

  it("rejects invalid signature", () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    expect(verifySlackSignature(secret, "v0=invalid", timestamp, "body")).toBe(false);
  });

  it("rejects null signature", () => {
    expect(verifySlackSignature(secret, null, "123", "body")).toBe(false);
  });

  it("rejects old timestamp", () => {
    const oldTimestamp = String(Math.floor(Date.now() / 1000) - 600);
    expect(verifySlackSignature(secret, "v0=test", oldTimestamp, "body")).toBe(false);
  });
});

describe("parseSlackPayload", () => {
  it("parses url_verification", () => {
    const result = parseSlackPayload({ type: "url_verification", challenge: "abc123" });
    expect(result.type).toBe("url_verification");
    expect(result.challenge).toBe("abc123");
  });

  it("parses event_callback", () => {
    const result = parseSlackPayload({ type: "event_callback", event: { type: "message", text: "hello" } });
    expect(result.type).toBe("event");
    expect(result.event.type).toBe("message");
  });

  it("handles unknown payload", () => {
    const result = parseSlackPayload({ type: "something_else" });
    expect(result.type).toBe("unknown");
  });
});
