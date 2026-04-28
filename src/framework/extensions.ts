import type { Hono } from "hono";
import type { EmbeddingProvider } from "../memory/embeddings.js";
import type { ProviderRouter } from "../providers/router.js";
import type { ProviderName } from "../providers/types.js";
import { logger } from "../utils/logger.js";
import type { EmbeddingFactory, ProviderFactory, RouteDeps, RouteRegistrar } from "./types.js";
import type { NyxHiveConfig } from "../types.js";

export function registerExtensionProviders(
  router: ProviderRouter,
  config: NyxHiveConfig,
  factories: ProviderFactory[] = [],
): string[] {
  const registered: string[] = [];

  for (const factory of factories) {
    try {
      router.registerProvider(factory.name as ProviderName, factory.create(config));
      logger.info(`Extension provider registered: ${factory.name}`);
      registered.push(factory.name);
    } catch (err) {
      logger.warn(`Extension provider ${factory.name} not available: ${err}`);
    }
  }

  return registered;
}

export function resolveExtensionEmbedder(
  config: NyxHiveConfig,
  current: EmbeddingProvider | undefined,
  factories: EmbeddingFactory[] = [],
): EmbeddingProvider | undefined {
  if (current) return current;

  for (const factory of factories) {
    try {
      const embedder = factory.create(config);
      logger.info(`Extension embedder registered: ${factory.name}`);
      return embedder;
    } catch (err) {
      logger.warn(`Extension embedder ${factory.name} not available: ${err}`);
    }
  }

  return undefined;
}

export function registerExtensionRoutes(
  app: Hono<any>,
  deps: RouteDeps,
  routes: RouteRegistrar[] = [],
): number {
  let registered = 0;

  for (const registerRoute of routes) {
    try {
      registerRoute(app, deps);
      registered++;
    } catch (err) {
      logger.warn(`Extension route registration failed: ${err}`);
    }
  }

  return registered;
}
