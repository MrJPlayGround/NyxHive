import { describe, it, expect } from "bun:test";
import { parseModalDirective, buildModalView } from "../channels/slack/modals.js";

describe("parseModalDirective", () => {
  it("parses title and fields", () => {
    const result = parseModalDirective("Bug Report | title:text, severity:select, description:textarea");
    expect(result.title).toBe("Bug Report");
    expect(result.fields).toHaveLength(3);
    expect(result.fields[0]).toEqual({ name: "title", type: "text" });
    expect(result.fields[2]).toEqual({ name: "description", type: "textarea" });
  });
  it("handles title-only", () => {
    const result = parseModalDirective("Simple Form");
    expect(result.title).toBe("Simple Form");
    expect(result.fields).toHaveLength(0);
  });
});

describe("buildModalView", () => {
  it("builds view with input blocks", () => {
    const view = buildModalView("Test Form", [
      { name: "name", type: "text" },
      { name: "notes", type: "textarea" },
    ], "cb-123");
    expect(view.type).toBe("modal");
    expect(view.title.text).toBe("Test Form");
    expect(view.blocks).toHaveLength(2);
    expect(view.callback_id).toContain("nyxhive:modal_submit:");
  });
  it("uses multiline for textarea", () => {
    const view = buildModalView("Form", [{ name: "desc", type: "textarea" }], "cb");
    expect(view.blocks[0].element.multiline).toBe(true);
  });
});
