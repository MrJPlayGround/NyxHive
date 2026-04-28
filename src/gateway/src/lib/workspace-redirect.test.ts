import { describe, expect, test } from "bun:test";
import { resolveWorkspaceOperationsUrl } from "./workspace-redirect";

describe("gateway workspace operations redirect", () => {
  test("maps the NyxAI gateway port to the Nyx workspace app port", () => {
    expect(
      resolveWorkspaceOperationsUrl({
        protocol: "http:",
        hostname: "127.0.0.1",
        port: "3779",
      }),
    ).toBe("http://127.0.0.1:3777/operations");
  });

  test("maps the Vortex gateway port to the Vortex workspace app port", () => {
    expect(
      resolveWorkspaceOperationsUrl({
        protocol: "http:",
        hostname: "127.0.0.1",
        port: "3778",
      }),
    ).toBe("http://127.0.0.1:3781/operations");
  });
});
