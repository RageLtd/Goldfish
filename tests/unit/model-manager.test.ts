import { afterAll, describe, expect, it } from "bun:test";
import { serverUrl } from "../../src/constants";
import {
  type ChatMessage,
  createModelManager,
  formatQwen3Prompt,
  type ToolDefinition,
} from "../../src/models/manager";

// ============================================================================
// Mock llama-servers — single server per role, handler swapped per test
// ============================================================================

const GEN_PORT = 18910;
const EMBED_PORT = 18911;
const GEN_URL = serverUrl(GEN_PORT);
const EMBED_URL = serverUrl(EMBED_PORT);

type MockHandler = (request: Request) => Response | Promise<Response>;

let genHandler: MockHandler = () => new Response("no handler", { status: 500 });
let embedHandler: MockHandler = () =>
  new Response("no handler", { status: 500 });

const genServer = Bun.serve({
  port: GEN_PORT,
  fetch: (req) => genHandler(req),
});
const embedServer = Bun.serve({
  port: EMBED_PORT,
  fetch: (req) => embedHandler(req),
});

afterAll(() => {
  genServer.stop(true);
  embedServer.stop(true);
});

// ============================================================================
// Tests
// ============================================================================

describe("ModelManager", () => {
  describe("getConfig", () => {
    it("creates with default configuration", () => {
      const manager = createModelManager({
        generationUrl: GEN_URL,
        embeddingUrl: EMBED_URL,
      });
      const config = manager.getConfig();
      expect(config.generativeModelId).toContain("Qwen3-0.6B-Q8_0.gguf");
      expect(config.embeddingModelId).toContain("all-MiniLM-L6-v2-Q8_0.gguf");
      expect(config.generationUrl).toBe(GEN_URL);
      expect(config.embeddingUrl).toBe(EMBED_URL);
    });

    it("accepts custom model paths via config", () => {
      const manager = createModelManager({
        generativeModelId: "/custom/gen.gguf",
        embeddingModelId: "/custom/embed.gguf",
        generationUrl: GEN_URL,
        embeddingUrl: EMBED_URL,
      });
      expect(manager.getConfig().generativeModelId).toBe("/custom/gen.gguf");
      expect(manager.getConfig().embeddingModelId).toBe("/custom/embed.gguf");
    });
  });

  describe("computeEmbedding", () => {
    it("calls /v1/embeddings and returns Float32Array", async () => {
      let capturedBody: Record<string, unknown> | null = null;

      embedHandler = async (req) => {
        capturedBody = (await req.json()) as Record<string, unknown>;
        return Response.json({
          data: [{ embedding: [0.1, 0.2, 0.3, 0.4, 0.5] }],
        });
      };

      const manager = createModelManager({
        embeddingModelId: "/models/embed.gguf",
        generationUrl: GEN_URL,
        embeddingUrl: EMBED_URL,
      });
      const result = await manager.computeEmbedding("test text");

      expect(result).toBeInstanceOf(Float32Array);
      expect(result.length).toBe(5);
      expect(result[0]).toBeCloseTo(0.1);
      expect(capturedBody!.input).toBe("test text");
    });

    it("throws on server error", async () => {
      embedHandler = async () => new Response("error", { status: 500 });

      const manager = createModelManager({
        embeddingModelId: "/models/embed.gguf",
        generationUrl: GEN_URL,
        embeddingUrl: EMBED_URL,
      });

      await expect(manager.computeEmbedding("test")).rejects.toThrow("500");
    });
  });

  describe("generateText", () => {
    it("calls /v1/completions with formatted prompt", async () => {
      let capturedBody: Record<string, unknown> | null = null;

      genHandler = async (req) => {
        capturedBody = (await req.json()) as Record<string, unknown>;
        return Response.json({
          choices: [{ text: "Generated response text" }],
        });
      };

      const manager = createModelManager({
        generativeModelId: "/models/gen.gguf",
        generationUrl: GEN_URL,
        embeddingUrl: EMBED_URL,
      });
      const messages: ChatMessage[] = [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "Hello" },
      ];
      const result = await manager.generateText(messages);

      expect(result).toBe("Generated response text");
      expect(capturedBody!.prompt).toContain("<|im_start|>system");
      expect(capturedBody!.prompt).toContain("You are helpful.");
    });

    it("throws on server error", async () => {
      genHandler = async () => new Response("error", { status: 500 });

      const manager = createModelManager({
        generativeModelId: "/models/gen.gguf",
        generationUrl: GEN_URL,
        embeddingUrl: EMBED_URL,
      });

      await expect(
        manager.generateText([{ role: "user", content: "Hello" }]),
      ).rejects.toThrow("500");
    });
  });

  describe("dispose", () => {
    it("resolves without error", async () => {
      const manager = createModelManager({
        generationUrl: GEN_URL,
        embeddingUrl: EMBED_URL,
      });
      await expect(manager.dispose()).resolves.toBeUndefined();
    });
  });
});

describe("formatQwen3Prompt", () => {
  it("formats basic messages in ChatML format", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hello" },
    ];
    const result = formatQwen3Prompt(messages);

    expect(result).toContain("<|im_start|>system\nYou are helpful.<|im_end|>");
    expect(result).toContain("<|im_start|>user\nHello<|im_end|>");
    expect(result).toContain("<|im_start|>assistant\n<think>\n\n</think>");
  });

  it("injects tool definitions into system message", () => {
    const tools: ToolDefinition[] = [
      {
        type: "function",
        function: {
          name: "create_observation",
          description: "Record an observation",
          parameters: { type: "object", properties: {} },
        },
      },
    ];

    const result = formatQwen3Prompt(
      [
        { role: "system", content: "You are an observer." },
        { role: "user", content: "Tool: Edit" },
      ],
      tools,
    );

    expect(result).toContain("<tools>");
    expect(result).toContain("create_observation");
    expect(result).toContain("<|im_start|>system");
    expect(result).toContain("<think>");
  });
});
