import { describe, it, expect } from "bun:test";
import { isCategoryStyleTitle } from "../memory/obsidian.js";

describe("isCategoryStyleTitle", () => {
  it("detects noun-only titles as category-style", () => {
    expect(isCategoryStyleTitle("Memory System")).toBe(true);
    expect(isCategoryStyleTitle("Auth Configuration")).toBe(true);
    expect(isCategoryStyleTitle("Deployment Pipeline")).toBe(true);
  });

  it("accepts claim-style titles with verbs", () => {
    expect(isCategoryStyleTitle("SQLite outperforms Postgres for our workload")).toBe(false);
    expect(isCategoryStyleTitle("agents need externalized memory to compound")).toBe(false);
  });

  it("detects verbs even in short titles", () => {
    expect(isCategoryStyleTitle("SQLite wins")).toBe(false);
    expect(isCategoryStyleTitle("retries fail silently")).toBe(false);
  });

  it("flags single-word titles as category-style", () => {
    expect(isCategoryStyleTitle("Auth")).toBe(true);
  });
});
