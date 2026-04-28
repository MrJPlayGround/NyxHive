import { describe, expect, it } from "bun:test";
import { toDisplayPath, toDisplayPathSegments } from "./display-path";

describe("toDisplayPath", () => {
  it("keeps repo-relative source paths intact", () => {
    expect(toDisplayPath("src/gateway/src/pages/Chat.tsx")).toBe("src/gateway/src/pages/Chat.tsx");
  });

  it("strips absolute paths down to a safe repo-relative display form", () => {
    expect(toDisplayPath("/home/user/dev/nyxhive/src/channels/slack.ts")).toBe("src/channels/slack.ts");
  });

  it("falls back to the shortest meaningful safe path when no repo marker exists", () => {
    expect(toDisplayPath("/home/user/dev/nyxhive/package.json")).toBe("nyxhive/package.json");
  });

  it("drops traversal segments from relative display paths", () => {
    expect(toDisplayPathSegments("../../secrets/.env")).toEqual(["secrets", ".env"]);
  });
});
