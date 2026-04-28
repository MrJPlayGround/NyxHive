import { describe, expect, test } from "bun:test";
import { resolveDiscordAttachmentPayloads } from "../channels/discord.js";
import type { BlockedPathInput } from "../runs/blockers.js";
import type { BlockedPathReport, InboundArtifactRecord } from "../types.js";
import type { DelegationRunStore } from "../runs/store.js";

type ArtifactFailureInput = Parameters<DelegationRunStore["recordInboundArtifactFailure"]>[0];

function makeRuns() {
  const recorded: BlockedPathInput[] = [];
  const artifacts: InboundArtifactRecord[] = [];
  return {
    recorded,
    artifacts,
    runs: {
      recordBlockedPath(input: BlockedPathInput): BlockedPathReport {
        recorded.push(input);
        return {
          id: `blocked-${recorded.length}`,
          created_at: 123,
          ...input,
        };
      },
      recordInboundArtifactFailure(input: ArtifactFailureInput): InboundArtifactRecord {
        const artifact: InboundArtifactRecord = {
          artifact_id: `artifact-${artifacts.length + 1}`,
          run_id: input.run_id ?? null,
          message_id: input.message_id ?? null,
          trace_id: input.trace_id ?? null,
          channel: input.channel ?? null,
          source: input.source,
          name: input.name ?? null,
          mime_type: input.mime_type ?? null,
          size_bytes: input.size_bytes ?? null,
          sha256: null,
          storage_path: null,
          acquisition_status: "failed",
          acquisition_error: input.acquisition_error,
          handler_status: input.handler_status ?? "unsupported",
          handler: input.handler ?? null,
          created_at: 123,
          updated_at: 123,
        };
        artifacts.push(artifact);
        return artifact;
      },
    },
  };
}

function attachment(overrides: Record<string, unknown> = {}) {
  return {
    name: "payload.bin",
    contentType: "application/octet-stream",
    size: 128,
    url: "https://cdn.discordapp.com/attachments/1/payload.bin",
    ...overrides,
  };
}

describe("Discord attachment blockers", () => {
  test("records unsupported attachments as structured blocked paths", async () => {
    const { runs, recorded, artifacts } = makeRuns();

    const result = await resolveDiscordAttachmentPayloads({
      attachments: [
        attachment({
          name: "clip.mp4",
          contentType: "video/mp4",
          url: "https://cdn.discordapp.com/attachments/1/clip.mp4",
        }),
      ],
      message_id: "discord-msg-1",
      runs,
      fetchImpl: async () => {
        throw new Error("fetch should not run for unsupported attachment");
      },
    });

    expect(result.shouldStop).toBe(true);
    expect(result.files).toBeUndefined();
    expect(result.reply).toContain("Unsupported attachment type");
    expect(result.blocked_paths).toHaveLength(1);
    expect(result.blocked_paths[0]).toMatchObject({
      id: "blocked-1",
      message_id: "discord-msg-1",
      channel: "discord",
      area: "attachment",
      failed_path: "discord.attachment.mime.unsupported",
      missing_primitive: "attachment.mime.supported_handler",
      next_action: "fix",
      requires_approval: false,
    });
    expect(recorded).toHaveLength(1);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({
      message_id: "discord-msg-1",
      channel: "discord",
      source: "discord.message.attachments[0]",
      name: "clip.mp4",
      mime_type: "video/mp4",
      acquisition_status: "failed",
      handler_status: "unsupported",
    });
  });

  test("records oversized attachments before download", async () => {
    const { runs, recorded, artifacts } = makeRuns();

    const result = await resolveDiscordAttachmentPayloads({
      attachments: [
        attachment({
          name: "huge.png",
          contentType: "image/png",
          size: 11 * 1024 * 1024,
          url: "https://cdn.discordapp.com/attachments/1/huge.png",
        }),
      ],
      message_id: "discord-msg-2",
      runs,
      fetchImpl: async () => {
        throw new Error("fetch should not run for oversized attachment");
      },
    });

    expect(result.shouldStop).toBe(true);
    expect(result.files).toBeUndefined();
    expect(result.reply).toContain("too large");
    expect(result.blocked_paths[0]).toMatchObject({
      failed_path: "discord.attachment.size.exceeded",
      missing_primitive: "attachment.limit.size",
      next_action: "ignore",
    });
    expect(recorded).toHaveLength(1);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({
      message_id: "discord-msg-2",
      name: "huge.png",
      acquisition_status: "failed",
      handler_status: "unsupported",
    });
  });

  test("records failed Discord CDN downloads", async () => {
    const { runs, recorded, artifacts } = makeRuns();

    const result = await resolveDiscordAttachmentPayloads({
      attachments: [
        attachment({
          name: "note.txt",
          contentType: "text/plain",
          url: "https://cdn.discordapp.com/attachments/1/note.txt",
        }),
      ],
      message_id: "discord-msg-3",
      runs,
      fetchImpl: async () =>
        new Response("missing", {
          status: 404,
          headers: { "content-length": "7" },
        }),
    });

    expect(result.shouldStop).toBe(true);
    expect(result.files).toBeUndefined();
    expect(result.reply).toContain("Failed to download");
    expect(result.blocked_paths[0]).toMatchObject({
      failed_path: "discord.attachment.download",
      missing_primitive: "attachment.download.fetch",
      next_action: "retry",
    });
    expect(recorded).toHaveLength(1);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({
      message_id: "discord-msg-3",
      name: "note.txt",
      mime_type: "text/plain",
      acquisition_status: "failed",
      handler_status: "unsupported",
    });
  });
});
