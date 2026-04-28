import { describe, it, expect } from "bun:test";
import { resolveSlackIdentity } from "../channels/slack/identity.js";

describe("resolveSlackIdentity", () => {
  it("returns empty object when no identity configured", () => {
    expect(resolveSlackIdentity(undefined)).toEqual({});
  });
  it("returns username and icon_emoji", () => {
    expect(resolveSlackIdentity({ slack_username: "Morph", slack_emoji: ":robot_face:" }))
      .toEqual({ username: "Morph", icon_emoji: ":robot_face:" });
  });
  it("returns username and icon_url", () => {
    expect(resolveSlackIdentity({ slack_username: "Nyx", slack_icon_url: "https://example.com/nyx.png" }))
      .toEqual({ username: "Nyx", icon_url: "https://example.com/nyx.png" });
  });
  it("prefers icon_url over icon_emoji", () => {
    const result = resolveSlackIdentity({ slack_username: "Test", slack_emoji: ":robot:", slack_icon_url: "https://example.com/icon.png" });
    expect(result.icon_url).toBe("https://example.com/icon.png");
    expect(result.icon_emoji).toBeUndefined();
  });
});
