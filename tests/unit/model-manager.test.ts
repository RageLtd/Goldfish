import { afterEach, describe, expect, it, mock } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ChatMessage,
  createModelManager,
  type ToolDefinition,
} from "../../src/models/manager";

// ============================================================================
// Mock Bun.spawn
// ============================================================================

const originalSpawn = Bun.spawn;

/** Override Bun.spawn for testing — uses Object.defineProperty to avoid `any` */
const setBunSpawn = (fn: typeof Bun.spawn): void => {
  Object.defineProperty(Bun, "spawn", { value: fn, writable: true });
};

const mockSpawn = (stdout: string, exitCode = 0): ReturnType<typeof mock> => {
  const spawnMock = mock((_args: string[], _opts: unknown) => ({
    stdout: new Response(stdout).body,
    exited: Promise.resolve(exitCode),
  }));
  setBunSpawn(spawnMock as unknown as typeof Bun.spawn);
  return spawnMock;
};

// ============================================================================
// Tests
// ============================================================================

describe("ModelManager", () => {
  afterEach(() => {
    setBunSpawn(originalSpawn);
  });

  describe("getConfig", () => {
    it("creates with default configuration", () => {
      const manager = createModelManager({});
      const config = manager.getConfig();
      expect(config.generativeModelId).toContain("Qwen3-0.6B-Q8_0.gguf");
      expect(config.embeddingModelId).toContain("all-MiniLM-L6-v2-Q8_0.gguf");
      expect(config.cliPath).toContain(".claude-mem/bin");
    });

    it("accepts custom model paths via config", () => {
      const manager = createModelManager({
        generativeModelId: "/custom/gen.gguf",
        embeddingModelId: "/custom/embed.gguf",
      });
      expect(manager.getConfig().generativeModelId).toBe("/custom/gen.gguf");
      expect(manager.getConfig().embeddingModelId).toBe("/custom/embed.gguf");
    });

    it("accepts custom CLI path", () => {
      const manager = createModelManager({ cliPath: "/opt/llama" });
      expect(manager.getConfig().cliPath).toBe("/opt/llama");
    });
  });

  describe("computeEmbedding", () => {
    it("calls llama-embedding and returns Float32Array", async () => {
      const embeddingJson = JSON.stringify({
        data: [{ embedding: [0.1, 0.2, 0.3, 0.4, 0.5] }],
      });
      const spawnMock = mockSpawn(embeddingJson);

      const manager = createModelManager({
        embeddingModelId: "/models/embed.gguf",
      });
      const result = await manager.computeEmbedding("test text");

      expect(result).toBeInstanceOf(Float32Array);
      expect(result.length).toBe(5);
      expect(result[0]).toBeCloseTo(0.1);

      // Verify spawn was called with correct args
      const call = spawnMock.mock.calls[0];
      const args = call[0] as string[];
      expect(args[0]).toContain("llama-embedding");
      expect(args).toContain("-m");
      expect(args).toContain("/models/embed.gguf");
      expect(args).toContain("-p");
      expect(args).toContain("test text");
      expect(args).toContain("--embd-output-format");
      expect(args).toContain("json");
    });

    it("uses custom CLI path when configured", async () => {
      const embeddingJson = JSON.stringify({
        data: [{ embedding: [0.1] }],
      });
      const spawnMock = mockSpawn(embeddingJson);

      const manager = createModelManager({
        cliPath: "/opt/llama",
        embeddingModelId: "/models/embed.gguf",
      });
      await manager.computeEmbedding("test");

      const call = spawnMock.mock.calls[0];
      const args = call[0] as string[];
      expect(args[0]).toBe(join("/opt/llama", "llama-embedding"));
    });

    it("throws on non-zero exit code", async () => {
      mockSpawn("", 1);

      const manager = createModelManager({
        embeddingModelId: "/models/embed.gguf",
      });

      await expect(manager.computeEmbedding("test")).rejects.toThrow(
        "exited with code 1",
      );
    });
  });

  describe("generateText", () => {
    it("calls llama-completion with Qwen3 chat template", async () => {
      const spawnMock = mockSpawn("Generated response text");

      const manager = createModelManager({
        generativeModelId: "/models/gen.gguf",
      });
      const messages: ChatMessage[] = [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "Hello" },
      ];
      const result = await manager.generateText(messages);

      expect(result).toBe("Generated response text");

      const call = spawnMock.mock.calls[0];
      const args = call[0] as string[];
      expect(args[0]).toContain("llama-completion");
      expect(args).toContain("-m");
      expect(args).toContain("/models/gen.gguf");
      expect(args).toContain("-no-cnv");
      expect(args).toContain("--no-display-prompt");
      expect(args).toContain("-f");
    });

    it("injects tool definitions into system message when tools provided", async () => {
      let capturedPrompt = "";
      const spawnImpl = mock(
        (args: string[], _opts: Record<string, unknown>) => {
          // Read prompt file synchronously inside the mock, before cleanup deletes it
          const fIdx = args.indexOf("-f");
          if (fIdx !== -1) {
            capturedPrompt = readFileSync(args[fIdx + 1], "utf8");
          }
          return {
            stdout: new Response(
              '<tool_call>\n{"name": "create_observation", "arguments": {"type": "feature", "title": "Test", "narrative": "Test narrative"}}\n</tool_call>',
            ).body,
            exited: Promise.resolve(0),
          };
        },
      );
      setBunSpawn(spawnImpl as unknown as typeof Bun.spawn);

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

      const manager = createModelManager({
        generativeModelId: "/models/gen.gguf",
      });
      await manager.generateText(
        [
          { role: "system", content: "You are an observer." },
          { role: "user", content: "Tool: Edit" },
        ],
        tools,
      );

      expect(capturedPrompt).toContain("<tools>");
      expect(capturedPrompt).toContain("create_observation");
      expect(capturedPrompt).toContain("<|im_start|>system");
      expect(capturedPrompt).toContain("<think>");
    });

    it("strips stop sequences from output", async () => {
      mockSpawn("Response text<|im_end|>\nExtra stuff");

      const manager = createModelManager({
        generativeModelId: "/models/gen.gguf",
      });
      const result = await manager.generateText([
        { role: "user", content: "Hello" },
      ]);

      expect(result).toBe("Response text");
    });

    it("strips [end of text] marker from output", async () => {
      mockSpawn("Response text[end of text]");

      const manager = createModelManager({
        generativeModelId: "/models/gen.gguf",
      });
      const result = await manager.generateText([
        { role: "user", content: "Hello" },
      ]);

      expect(result).toBe("Response text");
    });

    it("throws on non-zero exit code", async () => {
      mockSpawn("", 1);

      const manager = createModelManager({
        generativeModelId: "/models/gen.gguf",
      });

      await expect(
        manager.generateText([{ role: "user", content: "Hello" }]),
      ).rejects.toThrow("exited with code 1");
    });
  });

  describe("dispose", () => {
    it("is a no-op that resolves without error", async () => {
      const manager = createModelManager({});
      await expect(manager.dispose()).resolves.toBeUndefined();
    });
  });
});
