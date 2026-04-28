// src/framework/index.ts
// Public API surface for NyxHive as a framework.

export { createHive } from "./create-hive.js";
export { assembleStores } from "./stores.js";
export type { StoresInit } from "./stores.js";
export { ENGINE_API_VERSION } from "./types.js";
export type {
  HiveOptions,
  Hive,
  HiveStores,
  ChannelFactory,
  ChannelDeps,
  CommandDefinition,
  CommandContext,
  CommandResult,
  RouteRegistrar,
  RouteDeps,
  TaskDefinition,
  TaskContext,
  AgentToolRegistration,
  ToolContext,
  ProviderFactory,
  EmbeddingFactory,
  MessageMiddleware,
  MiddlewareContext,
  PublicProcessorAPI,
  EnqueueOptions,
  ResponseData,
  ProcessorStatus,
  AgentStatus,
} from "./types.js";
export type {
  SlackSurfaceRegistration,
  SlackMessageSurface,
  SlackSlashCommandSurface,
  SlackSurfaceContext,
  SlackSurfaceResult,
} from "../channels/slack-types.js";
