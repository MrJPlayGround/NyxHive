import { describe, expect, test } from "bun:test";
import { usesLargeMessageBodyLimit } from "../server/body-limits.js";

describe("server body limits", () => {
  test("uses the large message body limit for session message handoffs", () => {
    expect(usesLargeMessageBodyLimit("/api/message")).toBe(true);
    expect(usesLargeMessageBodyLimit("/api/relay/callback")).toBe(true);
    expect(usesLargeMessageBodyLimit("/api/sessions/session-123/message")).toBe(true);
    expect(usesLargeMessageBodyLimit("/api/sessions/session-123")).toBe(false);
    expect(usesLargeMessageBodyLimit("/api/agents")).toBe(false);
  });
});
