/**
 * Model lifecycle manager using llama.cpp CLI binaries.
 * Invokes llama-embedding and llama-completion via Bun.spawn()
 * for embedding and text generation respectively.
 *
 * Expects GGUF model files on disk and llama.cpp binaries in
 * ~/.claude-mem/bin/ (or configured via CLAUDE_MEM_LLAMA_CLI_PATH).
 */

import { mkdtemp, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ============================================================================
// Types
// ============================================================================

export interface ModelManagerConfig {
  readonly generativeModelId: string;
  readonly embeddingModelId: string;
  readonly cliPath: string;
  readonly cacheDir: string;
}

export interface ModelManagerDeps {
  readonly generativeModelId?: string;
  readonly embeddingModelId?: string;
  readonly cliPath?: string;
  readonly cacheDir?: string;
}

export interface ModelManager {
  readonly getConfig: () => ModelManagerConfig;
  readonly generateText: (
    messages: readonly ChatMessage[],
    tools?: readonly ToolDefinition[],
  ) => Promise<string>;
  readonly computeEmbedding: (text: string) => Promise<Float32Array>;
  readonly dispose: () => Promise<void>;
}

export interface ChatMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

export interface ToolDefinition {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
  };
}

// ============================================================================
// Defaults
// ============================================================================

const DEFAULT_CACHE_DIR = join(process.env.HOME || "", ".claude-mem", "models");
const DEFAULT_CLI_PATH = join(process.env.HOME || "", ".claude-mem", "bin");
const DEFAULT_GEN_MODEL = join(DEFAULT_CACHE_DIR, "Qwen3-0.6B-Q8_0.gguf");
const DEFAULT_EMBED_MODEL = join(
  DEFAULT_CACHE_DIR,
  "all-MiniLM-L6-v2-Q8_0.gguf",
);

// ============================================================================
// Qwen3 Chat Template
// ============================================================================

/**
 * Formats messages into Qwen3 ChatML format with tool definitions.
 * When tools are provided, they're injected into the system message
 * and non-thinking mode is forced via an empty <think> block.
 */
const formatQwen3Prompt = (
  messages: readonly ChatMessage[],
  tools?: readonly ToolDefinition[],
): string => {
  let prompt = "";

  for (const msg of messages) {
    if (msg.role === "system" && tools && tools.length > 0) {
      // Inject tool definitions into system message
      const toolDefs = tools.map((t) => ({
        type: t.type,
        function: {
          name: t.function.name,
          description: t.function.description,
          parameters: t.function.parameters,
        },
      }));
      const toolBlock = `\n\n# Tools\n\nYou may call one or more functions to assist with the user query.\n\nYou are provided with function signatures within <tools></tools> XML tags:\n<tools>\n${JSON.stringify(toolDefs)}\n</tools>\n\nFor each function call, return a json object with function name and arguments within <tool_call></tool_call> XML tags:\n<tool_call>\n{"name": <function-name>, "arguments": <args-json-object>}\n</tool_call>`;
      prompt += `<|im_start|>system\n${msg.content}${toolBlock}<|im_end|>\n`;
    } else {
      prompt += `<|im_start|>${msg.role}\n${msg.content}<|im_end|>\n`;
    }
  }

  // Force non-thinking: empty <think> block in assistant prefix
  prompt += "<|im_start|>assistant\n<think>\n\n</think>\n\n";
  return prompt;
};

// ============================================================================
// CLI Helpers
// ============================================================================

/**
 * Resolves the full path to a llama.cpp binary.
 * If cliPath is a directory, appends the binary name.
 * Otherwise assumes it's already a prefix or that binaries are on PATH.
 */
const resolveBinary = (cliPath: string, name: string): string => {
  if (cliPath === "") return name;
  return join(cliPath, name);
};

/**
 * Runs a CLI process and returns stdout.
 * Returns an error result if the process exits non-zero.
 * Sets DYLD_LIBRARY_PATH (macOS) and LD_LIBRARY_PATH (Linux) so
 * llama.cpp shared libs are found alongside the binaries.
 */
const runProcess = async (
  args: readonly string[],
  cliPath: string,
): Promise<
  | { readonly ok: true; readonly stdout: string }
  | { readonly ok: false; readonly error: string }
> => {
  const env =
    cliPath !== ""
      ? {
          ...process.env,
          DYLD_LIBRARY_PATH: cliPath,
          LD_LIBRARY_PATH: cliPath,
        }
      : undefined;

  const proc = Bun.spawn(args as string[], {
    stdout: "pipe",
    stderr: "ignore",
    env,
  });

  const [stdout, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    return { ok: false, error: `${args[0]} exited with code ${exitCode}` };
  }

  return { ok: true, stdout };
};

// ============================================================================
// Factory
// ============================================================================

export const createModelManager = (deps: ModelManagerDeps): ModelManager => {
  const config: ModelManagerConfig = {
    generativeModelId:
      deps.generativeModelId ||
      process.env.CLAUDE_MEM_LLAMA_GENERATION_MODEL ||
      DEFAULT_GEN_MODEL,
    embeddingModelId:
      deps.embeddingModelId ||
      process.env.CLAUDE_MEM_LLAMA_EMBEDDING_MODEL ||
      DEFAULT_EMBED_MODEL,
    cliPath:
      deps.cliPath || process.env.CLAUDE_MEM_LLAMA_CLI_PATH || DEFAULT_CLI_PATH,
    cacheDir:
      deps.cacheDir || process.env.CLAUDE_MEM_MODEL_DIR || DEFAULT_CACHE_DIR,
  };

  const generateText = async (
    messages: readonly ChatMessage[],
    tools?: readonly ToolDefinition[],
  ): Promise<string> => {
    const prompt = formatQwen3Prompt(messages, tools);

    // Write prompt to temp file to avoid shell escaping issues
    const tmpDir = await mkdtemp(join(tmpdir(), "llama-"));
    const promptFile = join(tmpDir, "prompt.txt");

    try {
      await Bun.write(promptFile, prompt);

      const allStops = ["<|im_end|>", "[end of text]"];
      const stopArgs = allStops.flatMap((s) => ["-r", s]);

      const binary = resolveBinary(config.cliPath, "llama-completion");
      const result = await runProcess(
        [
          binary,
          "-m",
          config.generativeModelId,
          "-no-cnv",
          "-f",
          promptFile,
          "-n",
          "512",
          "--no-display-prompt",
          "--temp",
          "0.7",
          "--top-p",
          "0.8",
          "--top-k",
          "20",
          "--min-p",
          "0.0",
          "--presence-penalty",
          "1.0",
          "-c",
          "2048",
          "-ngl",
          "99",
          ...stopArgs,
        ],
        config.cliPath,
      );

      if (!result.ok) {
        throw new Error(result.error);
      }

      // Trim stop sequences from output
      let output = result.stdout.trim();
      for (const s of allStops) {
        const idx = output.indexOf(s);
        if (idx !== -1) {
          output = output.slice(0, idx);
        }
      }
      return output.trim();
    } finally {
      await unlink(promptFile).catch(() => {});
      await rmdir(tmpDir).catch(() => {});
    }
  };

  const computeEmbedding = async (text: string): Promise<Float32Array> => {
    const binary = resolveBinary(config.cliPath, "llama-embedding");
    const result = await runProcess(
      [
        binary,
        "-m",
        config.embeddingModelId,
        "-p",
        text,
        "--embd-output-format",
        "json",
        "--embd-normalize",
        "2",
        "-ngl",
        "99",
      ],
      config.cliPath,
    );

    if (!result.ok) {
      throw new Error(result.error);
    }

    const parsed = JSON.parse(result.stdout);
    const embedding: number[] = parsed.data?.[0]?.embedding ?? [];
    return new Float32Array(embedding);
  };

  const dispose = async (): Promise<void> => {
    // No-op: each CLI call is self-contained, no persistent state
  };

  return {
    getConfig: () => config,
    generateText,
    computeEmbedding,
    dispose,
  };
};
