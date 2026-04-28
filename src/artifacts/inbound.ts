import type { DelegationRunStore } from "../runs/store.js";
import { formatError } from "../utils/error.js";

interface RawInboundFile {
  name?: string | null;
  type?: string | null;
  data?: string | null;
}

interface RawInboundImage {
  type?: string | null;
  data?: string | null;
}

export function recordInboundArtifactAcquisitionFailures(
  runs: Pick<DelegationRunStore, "recordInboundArtifactFailure"> | undefined,
  input: {
    channel: string;
    source_prefix: string;
    error: unknown;
    files?: RawInboundFile[];
    images?: RawInboundImage[];
  },
): void {
  if (!runs) return;
  const acquisitionError = formatError(input.error);
  for (const [index, file] of (input.files ?? []).entries()) {
    runs.recordInboundArtifactFailure({
      channel: input.channel,
      source: `${input.source_prefix}.files[${index}]`,
      name: file.name ?? null,
      mime_type: file.type ?? null,
      acquisition_error: acquisitionError,
      handler_status: "unsupported",
    });
  }
  for (const [index, image] of (input.images ?? []).entries()) {
    runs.recordInboundArtifactFailure({
      channel: input.channel,
      source: `${input.source_prefix}.images[${index}]`,
      name: null,
      mime_type: image.type ?? null,
      acquisition_error: acquisitionError,
      handler_status: "unsupported",
    });
  }
}
