import { describe, it, expect } from "bun:test";
import { renderArgMenu } from "../channels/slack/arg-menus.js";

describe("renderArgMenu", () => {
  it("renders buttons for <= 5 options", () => {
    const blocks = renderArgMenu("Pick agent:", [
      { label: "Nyx", value: "nyx" },
      { label: "Morph", value: "morph" },
    ], "agent_select");
    const actions = blocks.find((b: any) => b.type === "actions");
    expect(actions.elements[0].type).toBe("button");
    expect(actions.elements).toHaveLength(2);
  });
  it("renders static_select for 6-100 options", () => {
    const options = Array.from({ length: 10 }, (_, i) => ({ label: `Opt ${i}`, value: `opt_${i}` }));
    const blocks = renderArgMenu("Pick:", options, "pick_select");
    const actions = blocks.find((b: any) => b.type === "actions");
    expect(actions.elements[0].type).toBe("static_select");
  });
  it("includes prompt text as section", () => {
    const blocks = renderArgMenu("Choose:", [{ label: "A", value: "a" }], "test");
    expect(blocks[0].text.text).toBe("Choose:");
  });
});
