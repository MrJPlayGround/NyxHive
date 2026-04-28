import { describe, expect, it } from "bun:test";
import { toRelativePath, toRelativePaths, stripAbsolutePaths } from "../utils/paths";

describe("toRelativePath", () => {
  it("returns already-relative paths unchanged", () => {
    expect(toRelativePath("src/channels/slack.ts")).toBe("src/channels/slack.ts");
    expect(toRelativePath("delivery.ts")).toBe("delivery.ts");
  });

  it("returns empty/falsy values unchanged", () => {
    expect(toRelativePath("")).toBe("");
  });

  it("strips with explicit project root", () => {
    expect(toRelativePath("/home/user/dev/nyxhive/src/channels/slack.ts", "/home/user/dev/nyxhive"))
      .toBe("src/channels/slack.ts");
  });

  it("strips with trailing-slash project root", () => {
    expect(toRelativePath("/home/user/dev/nyxhive/src/channels/slack.ts", "/home/user/dev/nyxhive/"))
      .toBe("src/channels/slack.ts");
  });

  it("falls back to heuristic when path does not start with root", () => {
    expect(toRelativePath("/other/place/src/foo.ts", "/home/user/dev/nyxhive"))
      .toBe("src/foo.ts");
  });

  it("uses heuristic for /src/ marker", () => {
    expect(toRelativePath("/home/user/dev/nyxhive/src/channels/slack/delivery.ts"))
      .toBe("src/channels/slack/delivery.ts");
  });

  it("uses heuristic for /lib/ marker", () => {
    expect(toRelativePath("/home/runner/project/lib/utils.ts"))
      .toBe("lib/utils.ts");
  });

  it("uses heuristic for /docs/ marker", () => {
    expect(toRelativePath("/home/user/dev/nyxhive/docs/plans/event-contract.md"))
      .toBe("docs/plans/event-contract.md");
  });

  it("uses heuristic for /tests/ marker", () => {
    expect(toRelativePath("/home/runner/project/tests/unit/foo.test.ts"))
      .toBe("tests/unit/foo.test.ts");
  });

  it("prefers leftmost marker so src/lib/x keeps src/ prefix", () => {
    expect(toRelativePath("/home/user/dev/nyxhive/src/lib/utils.ts"))
      .toBe("src/lib/utils.ts");
  });

  it("uses heuristic for /souls/ marker", () => {
    expect(toRelativePath("/home/user/dev/nyxhive/souls/nyx/identity.md"))
      .toBe("souls/nyx/identity.md");
  });

  it("falls back to the shortest meaningful tail when no marker matches", () => {
    expect(toRelativePath("/home/user/dev/nyxhive/package.json"))
      .toBe("nyxhive/package.json");
  });
});

describe("toRelativePaths", () => {
  it("strips a batch of paths", () => {
    const result = toRelativePaths([
      "/home/user/dev/nyxhive/src/a.ts",
      "/home/user/dev/nyxhive/src/b.ts",
      "already/relative.ts",
    ]);
    expect(result).toEqual(["src/a.ts", "src/b.ts", "already/relative.ts"]);
  });
});

describe("stripAbsolutePaths", () => {
  it("strips embedded absolute paths in free text", () => {
    expect(stripAbsolutePaths("Reading /home/user/dev/nyxhive/src/channels/slack.ts"))
      .toBe("Reading src/channels/slack.ts");
  });

  it("strips multiple paths in one string", () => {
    expect(stripAbsolutePaths("Edited /home/user/dev/nyxhive/src/a.ts and /home/user/lib/b.ts"))
      .toBe("Edited src/a.ts and lib/b.ts");
  });

  it("leaves non-path text untouched", () => {
    expect(stripAbsolutePaths("All tests passed")).toBe("All tests passed");
  });

  it("leaves relative paths untouched", () => {
    expect(stripAbsolutePaths("Editing src/foo.ts")).toBe("Editing src/foo.ts");
  });

  it("handles paths without known markers", () => {
    expect(stripAbsolutePaths("Found /home/user/dev/nyxhive/package.json"))
      .toBe("Found nyxhive/package.json");
  });
});
