import type { DelegationRunStore } from "../runs/store.js";
import type { BlockedPathNextAction } from "../types.js";
import { formatError } from "../utils/error.js";
import { logger } from "../utils/logger.js";

type BlockedPathRecorder = Pick<DelegationRunStore, "recordBlockedPath">;

export interface ChannelAttachmentBlockedPathInput {
  message_id?: string | null;
  trace_id?: string | null;
  channel: string;
  failed_path: string;
  trigger: string;
  inspected: string[];
  available_artifacts?: string[];
  missing_primitive: string;
  impact: string;
  next_action: BlockedPathNextAction;
  requires_approval: boolean;
}

export function recordChannelAttachmentBlockedPath(
  runs: BlockedPathRecorder | undefined,
  input: ChannelAttachmentBlockedPathInput,
) {
  if (!runs) return undefined;
  try {
    return runs.recordBlockedPath({
      run_id: null,
      message_id: input.message_id ?? null,
      trace_id: input.trace_id ?? null,
      channel: input.channel,
      area: "attachment",
      failed_path: input.failed_path,
      trigger: input.trigger,
      inspected: input.inspected,
      available_artifacts: input.available_artifacts ?? [],
      missing_primitive: input.missing_primitive,
      impact: input.impact,
      next_action: input.next_action,
      requires_approval: input.requires_approval,
    });
  } catch (error) {
    logger.warn(`[channels] Failed to record attachment blocked path: ${formatError(error)}`);
    return undefined;
  }
}
