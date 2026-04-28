import { describe, it, expect } from "bun:test";
import { parseInteractiveDirectives, buildBlockKitBlocks, resolveToken } from "../channels/slack/interactive.js";

describe("parseInteractiveDirectives", () => {
  it("extracts button directives from text", () => {
    const input = "Here are your options:\n[[slack_buttons: Approve:approve, Reject:reject]]";
    const result = parseInteractiveDirectives(input);
    expect(result.cleanText).toBe("Here are your options:");
    expect(result.directives).toHaveLength(1);
    expect(result.directives[0].type).toBe("buttons");
    expect(result.directives[0].options).toEqual([
      { label: "Approve", value: "approve" },
      { label: "Reject", value: "reject" },
    ]);
  });

  it("extracts select directives with placeholder", () => {
    const input = "Choose a model:\n[[slack_select: Pick model | Sonnet:sonnet, Opus:opus, Haiku:haiku]]";
    const result = parseInteractiveDirectives(input);
    expect(result.cleanText).toBe("Choose a model:");
    expect(result.directives).toHaveLength(1);
    expect(result.directives[0].type).toBe("select");
    expect(result.directives[0].placeholder).toBe("Pick model");
    expect(result.directives[0].options).toHaveLength(3);
  });

  it("returns original text when no directives", () => {
    const input = "Just a normal message";
    const result = parseInteractiveDirectives(input);
    expect(result.cleanText).toBe("Just a normal message");
    expect(result.directives).toHaveLength(0);
  });

  it("handles multiple directives", () => {
    const input = "Pick:\n[[slack_buttons: A:a, B:b]]\nAlso:\n[[slack_select: Choose | X:x, Y:y]]";
    const result = parseInteractiveDirectives(input);
    expect(result.directives).toHaveLength(2);
  });

  it("handles labels with spaces", () => {
    const input = "[[slack_buttons: Do Thing:do_thing, Cancel All:cancel_all]]";
    const result = parseInteractiveDirectives(input);
    expect(result.directives[0].options[0].label).toBe("Do Thing");
  });
});

describe("buildBlockKitBlocks", () => {
  it("builds section + actions blocks for buttons", () => {
    const blocks = buildBlockKitBlocks("Pick one:", [{
      type: "buttons" as const,
      options: [
        { label: "Yes", value: "yes" },
        { label: "No", value: "no" },
      ],
    }], "callback-123");
    expect(blocks).toHaveLength(2);
    expect(blocks[1].type).toBe("actions");
    expect(blocks[1].elements).toHaveLength(2);
    expect(blocks[1].elements[0].type).toBe("button");
  });

  it("builds section + actions blocks for select", () => {
    const blocks = buildBlockKitBlocks("Choose:", [{
      type: "select" as const,
      placeholder: "Pick one",
      options: [
        { label: "A", value: "a" },
        { label: "B", value: "b" },
      ],
    }], "callback-456");
    expect(blocks).toHaveLength(2);
    expect(blocks[1].elements[0].type).toBe("static_select");
  });

  it("uses opaque callback IDs (values not exposed)", () => {
    const blocks = buildBlockKitBlocks("Pick:", [{
      type: "buttons" as const,
      options: [{ label: "Secret", value: "secret_value" }],
    }], "cb-789");
    const button = blocks[1].elements[0];
    expect(button.action_id).toContain("nyxhive:");
  });
});

describe("resolveToken", () => {
  it("resolves a valid token", () => {
    const blocks = buildBlockKitBlocks("test", [{
      type: "buttons" as const,
      options: [{ label: "Go", value: "go_value" }],
    }], "test-cb");
    const tokenValue = blocks[1].elements[0].value;
    expect(resolveToken(tokenValue)).toBe("go_value");
  });

  it("returns null for unknown token", () => {
    expect(resolveToken("nonexistent")).toBeNull();
  });
});
