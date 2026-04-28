import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { registerExtensionProviders, registerExtensionRoutes, resolveExtensionEmbedder } from "../../framework/extensions.js";
import type { EmbeddingFactory, ProviderFactory, RouteDeps, RouteRegistrar } from "../../framework/types.js";
import type { NyxHiveConfig } from "../../types.js";

const CONFIG = {
  daemon: { name: "test-instance" },
} as NyxHiveConfig;

describe("framework extension helpers", () => {
  test("registerExtensionProviders registers successful factories and skips failures", () => {
    const calls: string[] = [];
    const router = {
      registerProvider(name: string) {
        calls.push(name);
      },
    };

    const providers: ProviderFactory[] = [
      {
        name: "openrouter",
        create: () => ({ name: "openrouter", complete: async () => { throw new Error("unused"); }, listModels: () => [] }),
      },
      {
        name: "broken",
        create: () => {
          throw new Error("boom");
        },
      },
    ];

    const registered = registerExtensionProviders(router as any, CONFIG, providers);

    expect(registered).toEqual(["openrouter"]);
    expect(calls).toEqual(["openrouter"]);
  });

  test("resolveExtensionEmbedder returns the current embedder when already present", () => {
    const current = { embed: async () => new Float32Array(), embedBatch: async () => [], dimensions: 3 };
    const factories: EmbeddingFactory[] = [
      {
        name: "custom",
        create: () => ({ embed: async () => new Float32Array([1, 2, 3]), embedBatch: async () => [new Float32Array([1, 2, 3])], dimensions: 3 }),
      },
    ];

    expect(resolveExtensionEmbedder(CONFIG, current as any, factories)).toBe(current);
  });

  test("resolveExtensionEmbedder uses the first successful extension factory", async () => {
    const factories: EmbeddingFactory[] = [
      {
        name: "broken",
        create: () => {
          throw new Error("boom");
        },
      },
      {
        name: "custom",
        create: () => ({ embed: async () => new Float32Array([1, 2, 3]), embedBatch: async () => [new Float32Array([1, 2, 3])], dimensions: 3 }),
      },
    ];

    const embedder = resolveExtensionEmbedder(CONFIG, undefined, factories);

    expect(embedder).toBeDefined();
    await expect(embedder!.embed("hello")).resolves.toEqual(new Float32Array([1, 2, 3]));
  });

  test("registerExtensionRoutes registers working routes and skips broken ones", async () => {
    const app = new Hono();
    const deps = {
      processor: {} as RouteDeps["processor"],
      config: CONFIG,
      stores: {} as RouteDeps["stores"],
    };

    const okRoute: RouteRegistrar = (server) => {
      server.get("/custom/ping", (c) => c.text("pong"));
    };
    const brokenRoute: RouteRegistrar = () => {
      throw new Error("boom");
    };

    const registered = registerExtensionRoutes(app, deps, [okRoute, brokenRoute]);
    const response = await app.request("/custom/ping");

    expect(registered).toBe(1);
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("pong");
  });
});
