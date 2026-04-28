import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { OpenRouterEmbedding } from "../memory/embeddings.js";

function okResponse(data: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(""),
  } as unknown as Response;
}

describe("OpenRouterEmbedding", () => {
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    fetchSpy = spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("handles responses without usage metadata", async () => {
    fetchSpy.mockResolvedValueOnce(okResponse({
      data: [{ embedding: [1, 2, 3], index: 0 }],
    }));

    const embedder = new OpenRouterEmbedding("test-key", "test-model", 3);
    const [embedding] = await embedder.embedBatch(["hello"]);

    expect(Array.from(embedding)).toEqual([1, 2, 3]);
  });

  it("throws when the API returns no embedding data", async () => {
    fetchSpy.mockResolvedValueOnce(okResponse({
      error: { message: "upstream said no" },
    }));

    const embedder = new OpenRouterEmbedding("test-key", "test-model", 3);

    await expect(embedder.embedBatch(["hello"])).rejects.toThrow(
      "Embedding API returned no data for batch 1",
    );
  });
});
