import type { Channel } from "../channels/types.js";
import type { ProviderRouter } from "../providers/router.js";
import {
  MAX_FILE_SIZE,
  MAX_FILES_PER_MESSAGE,
  SUPPORTED_AUDIO_TYPES,
  SUPPORTED_DOCUMENT_TYPES,
  SUPPORTED_FILE_TYPES,
  SUPPORTED_IMAGE_TYPES,
  isTextAttachmentMimeType,
  type FileAttachment,
} from "../providers/types.js";
import { classifyProviderFileOmission } from "../providers/file-blockers.js";
import type { NyxHiveConfig } from "../types.js";

export type CapabilityStatus = "supported" | "degraded" | "missing" | "unknown";

export interface CapabilityPrimitive {
  status: CapabilityStatus;
  evidence: string[];
  missing_primitive?: string;
  max_files?: number;
  max_bytes?: number;
  mime_types?: string[];
  notes?: string[];
}

export interface ProviderFileClassSupport {
  status: CapabilityStatus;
  missing_primitive?: string;
  evidence: string[];
}

export interface ProviderCapability {
  name: string;
  status: CapabilityStatus;
  configured: boolean;
  registered: boolean;
  credential_status: "available" | "missing_env" | "delegated" | "not_required" | "unknown";
  runtime: string;
  models: string[];
  circuit?: string;
  missing_primitive?: string;
  evidence: string[];
  file_support: Record<"image" | "text" | "pdf" | "audio" | "binary", ProviderFileClassSupport>;
}

export interface ChannelCapability {
  name: string;
  configured: boolean;
  connected: boolean | null;
  supports_outbound: boolean | null;
  attachment_ingest: CapabilityPrimitive;
  evidence: string[];
}

export interface CapabilitySnapshot {
  version: "capability_snapshot.v0";
  generated_at: number;
  sources: string[];
  primitives: Record<string, CapabilityPrimitive>;
  providers: ProviderCapability[];
  channels: ChannelCapability[];
  missing_primitives: string[];
  degraded_primitives: string[];
}

export interface CapabilitySnapshotInput {
  config: NyxHiveConfig;
  providerRouter?: Pick<ProviderRouter, "listRegisteredProviders" | "getHealthStatus">;
  channels?: Channel[];
  queueAvailable?: boolean;
  blockedPathReportsAvailable?: boolean;
  artifactStoreAvailable?: boolean;
}

const FILE_CLASS_SAMPLES: Record<keyof ProviderCapability["file_support"], FileAttachment> = {
  image: sampleFile("image.png", "image/png"),
  text: sampleFile("note.txt", "text/plain"),
  pdf: sampleFile("doc.pdf", "application/pdf"),
  audio: sampleFile("clip.mp3", "audio/mpeg"),
  binary: sampleFile("blob.bin", "application/octet-stream"),
};

function sampleFile(name: string, mimeType: string): FileAttachment {
  return { name, mimeType, base64: "", size: 1 };
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort((a, b) => a.localeCompare(b));
}

function configuredChannelNames(config: NyxHiveConfig): string[] {
  return [
    config.telegram ? "telegram" : null,
    config.discord ? "discord" : null,
    config.slack ? "slack" : null,
  ].filter((name): name is string => Boolean(name));
}

function channelAttachmentSupport(name: string): CapabilityPrimitive {
  if (name === "telegram" || name === "discord") {
    return {
      status: "supported",
      evidence: [
        "channels.attachment-blockers.recordChannelAttachmentBlockedPath",
        `channels.${name}.attachment_resolution`,
        "providers.types.inferSupportedFileType",
      ],
      max_files: MAX_FILES_PER_MESSAGE,
      max_bytes: MAX_FILE_SIZE,
      mime_types: sorted(SUPPORTED_FILE_TYPES),
    };
  }

  if (name === "slack") {
    return {
      status: "unknown",
      evidence: ["channels.slack.file_extraction"],
      notes: ["Slack file handling exists, but blocker-grade attachment failure evidence is not yet wired through v0."],
    };
  }

  return {
    status: "unknown",
    evidence: ["channels.runtime"],
    notes: ["No v0 attachment-ingest policy is defined for this channel."],
  };
}

function credentialStatus(providerConfig: NyxHiveConfig["providers"][string] | undefined): ProviderCapability["credential_status"] {
  if (!providerConfig) return "unknown";
  if (providerConfig.auth_mode === "codex") return "delegated";
  if (providerConfig.api_key_env) return process.env[providerConfig.api_key_env] ? "available" : "missing_env";
  if (providerConfig.url) return "not_required";
  return "unknown";
}

function providerRuntime(providerConfig: NyxHiveConfig["providers"][string] | undefined): string {
  if (!providerConfig) return "sdk";
  if (providerConfig.runtime) return providerConfig.runtime;
  if (providerConfig.auth_mode === "codex") return "codex";
  return "sdk";
}

function providerFileSupport(providerName: string, runtime: string): ProviderCapability["file_support"] {
  const blockerRuntime = runtime === "native_api" ? "native_api" : "sdk";
  return Object.fromEntries(
    Object.entries(FILE_CLASS_SAMPLES).map(([kind, file]) => {
      const omission = classifyProviderFileOmission(blockerRuntime, providerName, file);
      if (omission) {
        return [kind, {
          status: "missing",
          missing_primitive: omission.missingPrimitive,
          evidence: omission.inspected,
        }];
      }

      return [kind, {
        status: "supported",
        evidence: [
          `providers.${providerName}.complete.params.files`,
          file.mimeType.startsWith("image/")
            ? "providers.types.SUPPORTED_IMAGE_TYPES"
            : isTextAttachmentMimeType(file.mimeType)
              ? "providers.types.isTextAttachmentMimeType"
              : file.mimeType === "application/pdf"
                ? "providers.types.SUPPORTED_DOCUMENT_TYPES"
                : "providers.file-blockers.classifyProviderFileOmission",
        ],
      }];
    }),
  ) as ProviderCapability["file_support"];
}

function buildProviderCapabilities(input: CapabilitySnapshotInput): ProviderCapability[] {
  const registered = new Map<string, { name: string; models: string[]; circuit?: string }>();
  for (const provider of input.providerRouter?.listRegisteredProviders?.() ?? []) {
    registered.set(provider.name, provider);
  }

  const names = new Set([...Object.keys(input.config.providers ?? {}), ...registered.keys()]);
  return [...names].sort((a, b) => a.localeCompare(b)).map((name) => {
    const providerConfig = input.config.providers?.[name];
    const registeredProvider = registered.get(name);
    const configured = Boolean(providerConfig);
    const isRegistered = Boolean(registeredProvider);
    const runtime = providerRuntime(providerConfig);
    const status: CapabilityStatus = isRegistered ? "supported" : configured ? "missing" : "unknown";
    const missingPrimitive = !isRegistered && configured ? `provider.${name}.runtime_registration` : undefined;

    return {
      name,
      status,
      configured,
      registered: isRegistered,
      credential_status: credentialStatus(providerConfig),
      runtime,
      models: registeredProvider?.models ?? [],
      circuit: registeredProvider?.circuit,
      missing_primitive: missingPrimitive,
      evidence: [
        configured ? "config.providers" : "provider_router.registered_providers",
        isRegistered ? "provider_router.registered_providers" : "provider_router.registered_providers.absent",
      ],
      file_support: providerFileSupport(name, runtime),
    };
  });
}

function buildChannelCapabilities(input: CapabilitySnapshotInput): ChannelCapability[] {
  const runtimeChannels = new Map((input.channels ?? []).map((channel) => [channel.name, channel]));
  const names = new Set([...configuredChannelNames(input.config), ...runtimeChannels.keys()]);
  return [...names].sort((a, b) => a.localeCompare(b)).map((name) => {
    const runtimeChannel = runtimeChannels.get(name);
    return {
      name,
      configured: configuredChannelNames(input.config).includes(name),
      connected: runtimeChannel ? runtimeChannel.isConnected() : null,
      supports_outbound: runtimeChannel ? typeof runtimeChannel.sendOutbound === "function" : null,
      attachment_ingest: channelAttachmentSupport(name),
      evidence: [
        configuredChannelNames(input.config).includes(name) ? `config.${name}` : "channels.runtime",
        runtimeChannel ? "channels.runtime" : "channels.runtime.absent",
      ],
    };
  });
}

function collectMissing(snapshot: Pick<CapabilitySnapshot, "primitives" | "providers" | "channels">): string[] {
  const missing = new Set<string>();
  for (const primitive of Object.values(snapshot.primitives)) {
    if (primitive.status === "missing" && primitive.missing_primitive) missing.add(primitive.missing_primitive);
  }
  for (const provider of snapshot.providers) {
    if (provider.status === "missing" && provider.missing_primitive) missing.add(provider.missing_primitive);
    for (const support of Object.values(provider.file_support)) {
      if (support.status === "missing" && support.missing_primitive) missing.add(support.missing_primitive);
    }
  }
  for (const channel of snapshot.channels) {
    if (channel.attachment_ingest.status === "missing" && channel.attachment_ingest.missing_primitive) {
      missing.add(channel.attachment_ingest.missing_primitive);
    }
  }
  return sorted(missing);
}

function collectDegraded(snapshot: Pick<CapabilitySnapshot, "primitives" | "providers" | "channels">): string[] {
  const degraded = new Set<string>();
  for (const [id, primitive] of Object.entries(snapshot.primitives)) {
    if (primitive.status === "degraded") degraded.add(id);
  }
  for (const provider of snapshot.providers) {
    if (provider.status === "degraded") degraded.add(`provider.${provider.name}`);
  }
  for (const channel of snapshot.channels) {
    if (channel.attachment_ingest.status === "degraded") degraded.add(`channel.${channel.name}.attachment_ingest`);
  }
  return sorted(degraded);
}

export function buildCapabilitySnapshot(input: CapabilitySnapshotInput): CapabilitySnapshot {
  const primitives: Record<string, CapabilityPrimitive> = {
    "attachments.ingest": {
      status: "supported",
      evidence: [
        "security.attachments.normalizeInboundAttachments",
        "providers.types.SUPPORTED_FILE_TYPES",
        "channels.attachment-blockers.recordChannelAttachmentBlockedPath",
      ],
      max_files: MAX_FILES_PER_MESSAGE,
      max_bytes: MAX_FILE_SIZE,
      mime_types: sorted(SUPPORTED_FILE_TYPES),
    },
    "media.images": {
      status: "supported",
      evidence: ["providers.types.SUPPORTED_IMAGE_TYPES"],
      mime_types: sorted(SUPPORTED_IMAGE_TYPES),
    },
    "media.documents": {
      status: "supported",
      evidence: ["providers.types.SUPPORTED_DOCUMENT_TYPES"],
      mime_types: sorted(SUPPORTED_DOCUMENT_TYPES),
    },
    "media.audio_ingest": {
      status: "supported",
      evidence: ["providers.types.SUPPORTED_AUDIO_TYPES"],
      mime_types: sorted(SUPPORTED_AUDIO_TYPES),
    },
    "media.transcription": {
      status: "missing",
      evidence: [
        "providers.types.isTranscribableMimeType",
        "memory.media-extract.extractKnowledge.requires_existing_transcript",
      ],
      missing_primitive: "media.transcription.handler",
      notes: ["Audio files can be accepted, but v0 has no runtime transcription handler wired before provider handoff."],
    },
    "handoff.async_queue": {
      status: input.queueAvailable ? "supported" : "unknown",
      evidence: input.queueAvailable
        ? ["queue.db", "server.routes.messages.async_mode"]
        : ["server.routes.status.capabilities"],
    },
    "blocked_path.reports": {
      status: input.blockedPathReportsAvailable ? "supported" : "unknown",
      evidence: input.blockedPathReportsAvailable
        ? ["runs.store.recordBlockedPath", "blocked_path_reports"]
        : ["runs.store.absent"],
    },
    "artifacts.inbound": {
      status: input.artifactStoreAvailable ? "supported" : "unknown",
      evidence: input.artifactStoreAvailable
        ? ["runs.store.recordInboundArtifact", "inbound_artifacts", "server.routes.status.artifacts"]
        : ["runs.store.absent"],
      notes: ["Stores acquired inbound files and explicit acquisition failures; extraction handlers remain separate."],
    },
  };

  const providers = buildProviderCapabilities(input);
  const channels = buildChannelCapabilities(input);
  const partial = { primitives, providers, channels };

  return {
    version: "capability_snapshot.v0",
    generated_at: Date.now(),
    sources: [
      "config.providers",
      "config.channels",
      "provider_router.registered_providers",
      "providers.types.supported_file_types",
      "channels.runtime",
      "runs.store.blocked_path_reports",
      "runs.store.inbound_artifacts",
    ],
    primitives,
    providers,
    channels,
    missing_primitives: collectMissing(partial),
    degraded_primitives: collectDegraded(partial),
  };
}
