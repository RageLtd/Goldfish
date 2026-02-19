import { afterAll, describe, expect, it } from "bun:test";
import { serverUrl } from "../../src/constants";
import {
  serverComputeEmbedding,
  serverGenerateText,
} from "../../src/models/server-client";

// ============================================================================
// Mock HTTP Server — single server, handler swapped per test via reload()
// ============================================================================

const MOCK_PORT = 18901;
const MOCK_URL = serverUrl(MOCK_PORT);

type MockHandler = (request: Request) => Response | Promise<Response>;

let currentHandler: MockHandler = () =>
  new Response("no handler set", { status: 500 });

const server = Bun.serve({
  port: MOCK_PORT,
  fetch: (req) => currentHandler(req),
});

afterAll(() => server.stop(true));

const setHandler = (handler: MockHandler) => {
  currentHandler = handler;
};

// ============================================================================
// Tests
// ============================================================================

describe("serverGenerateText", () => {
  it("sends correct request format and returns generated text", async () => {
    let capturedBody: Record<string, unknown> | null = null;

    setHandler(async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/v1/completions" && req.method === "POST") {
        capturedBody = (await req.json()) as Record<string, unknown>;
        return Response.json({
          choices: [{ text: "Hello world" }],
        });
      }
      return new Response("Not found", { status: 404 });
    });

    const result = await serverGenerateText(MOCK_URL, "test prompt");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe("Hello world");
    }

    expect(capturedBody).not.toBeNull();
    expect(capturedBody!.prompt).toBe("test prompt");
    expect(capturedBody!.n_predict).toBe(512);
    expect(capturedBody!.temperature).toBe(0.7);
    expect(capturedBody!.top_p).toBe(0.8);
    expect(capturedBody!.top_k).toBe(20);
    expect(capturedBody!.stop).toEqual(["<|im_end|>", "[end of text]"]);
  });

  it("strips stop sequences from output", async () => {
    setHandler(async () =>
      Response.json({
        choices: [{ text: "Response text<|im_end|>\nExtra stuff" }],
      }),
    );

    const result = await serverGenerateText(MOCK_URL, "test");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe("Response text");
    }
  });

  it("strips [end of text] marker from output", async () => {
    setHandler(async () =>
      Response.json({
        choices: [{ text: "Response text[end of text]" }],
      }),
    );

    const result = await serverGenerateText(MOCK_URL, "test");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe("Response text");
    }
  });

  it("returns error on non-200 response", async () => {
    setHandler(
      async () => new Response("Internal Server Error", { status: 500 }),
    );

    const result = await serverGenerateText(MOCK_URL, "test");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("500");
    }
  });

  it("returns error on connection failure", async () => {
    const result = await serverGenerateText(serverUrl(19999), "test");
    expect(result.ok).toBe(false);
  });

  it("applies custom config overrides", async () => {
    let capturedBody: Record<string, unknown> | null = null;

    setHandler(async (req) => {
      capturedBody = (await req.json()) as Record<string, unknown>;
      return Response.json({ choices: [{ text: "ok" }] });
    });

    await serverGenerateText(MOCK_URL, "test", {
      nPredict: 256,
      temperature: 0.5,
      stop: ["<|end|>"],
    });

    expect(capturedBody).not.toBeNull();
    expect(capturedBody!.n_predict).toBe(256);
    expect(capturedBody!.temperature).toBe(0.5);
    expect(capturedBody!.stop).toEqual(["<|end|>"]);
  });
});

describe("serverComputeEmbedding", () => {
  it("sends correct request and returns Float32Array", async () => {
    let capturedBody: Record<string, unknown> | null = null;

    setHandler(async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/v1/embeddings" && req.method === "POST") {
        capturedBody = (await req.json()) as Record<string, unknown>;
        return Response.json({
          data: [{ embedding: [0.1, 0.2, 0.3, 0.4, 0.5] }],
        });
      }
      return new Response("Not found", { status: 404 });
    });

    const result = await serverComputeEmbedding(MOCK_URL, "test text");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBeInstanceOf(Float32Array);
      expect(result.value.length).toBe(5);
      expect(result.value[0]).toBeCloseTo(0.1);
    }

    expect(capturedBody).not.toBeNull();
    expect(capturedBody!.input).toBe("test text");
  });

  it("returns error on non-200 response", async () => {
    setHandler(async () => new Response("Bad Request", { status: 400 }));

    const result = await serverComputeEmbedding(MOCK_URL, "test");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("400");
    }
  });

  it("returns empty Float32Array when no embedding data", async () => {
    setHandler(async () => Response.json({ data: [] }));

    const result = await serverComputeEmbedding(MOCK_URL, "test");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.length).toBe(0);
    }
  });
});
