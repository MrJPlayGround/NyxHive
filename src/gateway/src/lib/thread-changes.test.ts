import { describe, expect, it } from "bun:test";
import { buildChangeTree } from "./thread-changes";
import type { ThreadChange } from "./chat-runtime";

function makeChange(filePath: string): ThreadChange {
  return {
    id: `change:${filePath}`,
    threadId: "thread-1",
    filePath,
    operation: "edit",
    linesAdded: 0,
    linesRemoved: 0,
    timestamp: Date.now(),
  };
}

describe("buildChangeTree", () => {
  it("builds folder labels from normalized display paths while keeping raw file paths for selection", () => {
    const tree = buildChangeTree([
      makeChange("/home/user/dev/nyxhive/src/channels/slack.ts"),
      makeChange("/home/user/dev/nyxhive/src/gateway/src/pages/Chat.tsx"),
    ]);

    expect(tree[0].label).toBe("src");
    const slackNode = tree[0].children[0].children[0];
    expect(slackNode.label).toBe("slack.ts");
    expect(slackNode.path).toBe("src/channels/slack.ts");
    expect(slackNode.rawPath).toBe("/home/user/dev/nyxhive/src/channels/slack.ts");
    expect(slackNode.displayPath).toBe("src/channels/slack.ts");
  });

  it("deduplicates absolute and relative variants of the same display path", () => {
    const absolute = makeChange("/home/user/dev/nyxhive/src/channels/slack.ts");
    const relative = { ...makeChange("src/channels/slack.ts"), timestamp: absolute.timestamp + 1000 };

    const tree = buildChangeTree([absolute, relative]);
    const slackFolder = tree[0].children[0];

    expect(slackFolder.children).toHaveLength(1);
    expect(slackFolder.children[0].rawPath).toBe("src/channels/slack.ts");
  });
});
