import { describe, expect, test } from "bun:test";
import { recordChannelAttachmentBlockedPath } from "../channels/attachment-blockers.js";
import type { BlockedPathInput } from "../runs/blockers.js";
import type { BlockedPathReport } from "../types.js";

describe("channel attachment blockers", () => {
  test("persists a structured blocker for channel attachment failures", () => {
    const recorded: unknown[] = [];
    const runs = {
      recordBlockedPath(input: BlockedPathInput): BlockedPathReport {
        recorded.push(input);
        return {
          id: "blocked-1",
          created_at: 123,
          ...input,
        };
      },
    };

    const report = recordChannelAttachmentBlockedPath(runs, {
      message_id: "42",
      channel: "telegram",
      failed_path: "telegram.attachment.mime.unsupported",
      trigger: "Unsupported file type: application/x-sh",
      inspected: ["telegram.message.document", "providers.inferSupportedFileType"],
      missing_primitive: "attachment.mime.supported_handler",
      impact: "Telegram attachment request rejected before processing; no model run was started.",
      next_action: "fix",
      requires_approval: false,
    });

    expect(report).toMatchObject({
      id: "blocked-1",
      run_id: null,
      message_id: "42",
      trace_id: null,
      channel: "telegram",
      area: "attachment",
      failed_path: "telegram.attachment.mime.unsupported",
      trigger: "Unsupported file type: application/x-sh",
      inspected: ["telegram.message.document", "providers.inferSupportedFileType"],
      available_artifacts: [],
      missing_primitive: "attachment.mime.supported_handler",
      impact: "Telegram attachment request rejected before processing; no model run was started.",
      next_action: "fix",
      requires_approval: false,
    });
    expect(recorded).toHaveLength(1);
  });

  test("is a no-op when no run store is available", () => {
    const report = recordChannelAttachmentBlockedPath(undefined, {
      channel: "telegram",
      failed_path: "telegram.attachment.download",
      trigger: "Failed to download document: HTTP 500",
      inspected: ["telegram.api.getFile", "telegram.file.download"],
      missing_primitive: "attachment.download.fetch",
      impact: "Telegram attachment could not be downloaded; no model run was started.",
      next_action: "retry",
      requires_approval: false,
    });

    expect(report).toBeUndefined();
  });

  test("does not let persistence failures break the channel path", () => {
    const runs = {
      recordBlockedPath() {
        throw new Error("database locked");
      },
    };

    const report = recordChannelAttachmentBlockedPath(runs, {
      channel: "telegram",
      failed_path: "telegram.attachment.download",
      trigger: "Failed to download document: HTTP 500",
      inspected: ["telegram.api.getFile", "telegram.file.download"],
      missing_primitive: "attachment.download.fetch",
      impact: "Telegram attachment could not be downloaded; no model run was started.",
      next_action: "retry",
      requires_approval: false,
    });

    expect(report).toBeUndefined();
  });
});
