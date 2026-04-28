import { describe, expect, test } from "bun:test";
import { inferRepoSlug, resolveRepoChoice } from "../cli/setup.js";

describe("setup helpers", () => {
  test("resolves the nyxlabs preset", () => {
    expect(resolveRepoChoice("nyxlabs")).toEqual({
      key: "nyxlabs",
      label: "NyxLabs",
      url: "git@github.com:example-org/NyxLabs.git",
      preset: true,
    });
  });

  test("accepts custom git URLs", () => {
    expect(resolveRepoChoice("git@github.com:example-org/Vortex.git")).toEqual({
      key: "vortex",
      label: "Vortex",
      url: "git@github.com:example-org/Vortex.git",
      preset: false,
    });
  });

  test("rejects unknown aliases", () => {
    expect(resolveRepoChoice("vortex")).toBeNull();
  });

  test("infers repo slug from https URLs", () => {
    expect(inferRepoSlug("https://github.com/example-org/NyxLabs.git")).toBe("NyxLabs");
  });
});
