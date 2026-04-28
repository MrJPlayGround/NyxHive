import { afterEach, describe, expect, it } from "bun:test";
import { resolveMcpToolProfile } from "../agents/mcp-tool-profiles.js";

describe("MCP tool profiles", () => {
  afterEach(() => {
    delete process.env.NYXHIVE_MCP_PROFILE_MODE;
  });

  it("drops MCP tools for ordinary conversation turns", () => {
    const decision = resolveMcpToolProfile({
      requestedTools: ["search_knowledge", "list_proposals", "brave_web_search"],
      taskType: "conversation",
      message: "hey",
    });

    expect(decision.profile).toBe("conversation");
    expect(decision.exposedTools).toEqual([]);
    expect(decision.droppedTools).toEqual(["search_knowledge", "list_proposals", "brave_web_search"]);
    expect(decision.estimatedSavedTokens).toBe(1500);
  });

  it("keeps coding-relevant tools and drops web/browser tools unless hinted", () => {
    const decision = resolveMcpToolProfile({
      requestedTools: ["search_knowledge", "git_log", "brave_web_search", "open_browser"],
      taskType: "coding",
      message: "fix the proposal executor tests",
    });

    expect(decision.profile).toBe("coding");
    expect(decision.exposedTools).toEqual(["search_knowledge", "git_log"]);
    expect(decision.droppedTools).toEqual(["brave_web_search", "open_browser"]);
  });

  it("adds web and browser tools when the message asks for them", () => {
    const decision = resolveMcpToolProfile({
      requestedTools: ["search_knowledge", "brave_web_search", "open_browser"],
      taskType: "coding",
      message: "debug the frontend screenshot and look up the latest browser behavior",
    });

    expect(decision.profile).toBe("coding+research+browser");
    expect(decision.exposedTools).toEqual(["search_knowledge", "brave_web_search", "open_browser"]);
    expect(decision.droppedTools).toEqual([]);
  });

  it("adds research tools for weather and forecast requests", () => {
    const decision = resolveMcpToolProfile({
      requestedTools: ["search_knowledge", "brave_web_search", "brave_local_search", "open_browser"],
      taskType: "conversation",
      message: "what's the weather gonna be like in Lisbon tomorrow?",
    });

    expect(decision.profile).toBe("conversation+research");
    expect(decision.exposedTools).toEqual(["brave_web_search", "brave_local_search"]);
    expect(decision.droppedTools).toEqual(["search_knowledge", "open_browser"]);
  });

  it("can be disabled for emergency compatibility", () => {
    process.env.NYXHIVE_MCP_PROFILE_MODE = "off";

    const decision = resolveMcpToolProfile({
      requestedTools: ["search_knowledge", "unknown_remote_tool"],
      taskType: "conversation",
      message: "hey",
    });

    expect(decision.profile).toBe("disabled");
    expect(decision.exposedTools).toEqual(["search_knowledge", "unknown_remote_tool"]);
    expect(decision.droppedTools).toEqual([]);
  });
});
