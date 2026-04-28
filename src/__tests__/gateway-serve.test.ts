import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { buildWorkspaceRedirectUrl, registerRetiredGatewayUiRoutes } from "../server/index.js";

describe("retired gateway UI serving", () => {
  it("redirects non-API browser routes to the workspace UI", () => {
    expect(buildWorkspaceRedirectUrl("/", "", "http://localhost:3777/")).toBe("http://localhost:3777/");
    expect(buildWorkspaceRedirectUrl("/chat/new", "mode=build", "http://localhost:3777/")).toBe(
      "http://localhost:3777/chat/new?mode=build",
    );
    expect(buildWorkspaceRedirectUrl("/assets/main.js", "", "http://localhost:3777/")).toBe("http://localhost:3777/");
  });

  it("does not let unknown API routes fall through to the retired UI", async () => {
    const app = new Hono();
    registerRetiredGatewayUiRoutes(app, "http://localhost:3777/");

    const apiResponse = await app.request("/api/not-real");
    expect(apiResponse.status).toBe(404);
    expect(apiResponse.headers.get("content-type")).toContain("application/json");

    const browserResponse = await app.request("/chat/new");
    expect(browserResponse.status).toBe(308);
    expect(browserResponse.headers.get("location")).toBe("http://localhost:3777/chat/new");
  });

  it("does not redirect OpenAI-compatible service routes to the workspace UI", async () => {
    const app = new Hono();
    registerRetiredGatewayUiRoutes(app, "http://localhost:3777/");

    const modelsResponse = await app.request("/v1/models");
    expect(modelsResponse.status).toBe(404);
    expect(modelsResponse.headers.get("content-type")).toContain("application/json");
    expect(modelsResponse.headers.get("location")).toBeNull();

    const chatResponse = await app.request("/v1/chat/completions");
    expect(chatResponse.status).toBe(404);
    expect(chatResponse.headers.get("content-type")).toContain("application/json");
    expect(chatResponse.headers.get("location")).toBeNull();
  });
});
