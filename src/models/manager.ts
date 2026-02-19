/**
 * Model lifecycle manager using persistent llama-server instances.
 * Delegates to server-client.ts for HTTP calls to /v1/completions
 * and /v1/embeddings endpoints.
 *
 * Callers must start llama-server processes (via server-manager.ts)
 * before creating a ModelManager, and stop them after dispose().
 */

import {
  DEFAULT_EMBED_MODEL_PATH,
  DEFAULT_GEN_MODEL_PATH,
  DEFAULT_MODEL_DIR,
} from "../constants";
import { serverComputeEmbedding, serverGenerateText } from "./server-client";

// ============================================================================
// Types
// ============================================================================

export interface ModelManagerConfig {
  readonly generativeModelId: string;
  readonly embeddingModelId: string;
  readonly generationUrl: string;
  readonly embeddingUrl: string;
  readonly cacheDir: string;
}

export interface ModelManagerDeps {
  readonly generativeModelId?: string;
  readonly embeddingModelId?: string;
  readonly generationUrl: string;
  readonly embeddingUrl: string;
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

// ============================================================================
// Qwen3 Chat Template
// ============================================================================

/**
 * Formats messages into Qwen3 ChatML format with tool definitions.
 * When tools are provided, they're injected into the system message
 * and non-thinking mode is forced via an empty <think> block.
 */
export const formatQwen3Prompt = (
  messages: readonly ChatMessage[],
  tools?: readonly ToolDefinition[],
): string => {
  let prompt = "";

  for (const msg of messages) {
    if (msg.role === "system" && tools && tools.length > 0) {
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
// Factory
// ============================================================================

export const createModelManager = (deps: ModelManagerDeps): ModelManager => {
  const config: ModelManagerConfig = {
    generativeModelId:
      deps.generativeModelId ||
      process.env.CLAUDE_MEM_LLAMA_GENERATION_MODEL ||
      DEFAULT_GEN_MODEL_PATH,
    embeddingModelId:
      deps.embeddingModelId ||
      process.env.CLAUDE_MEM_LLAMA_EMBEDDING_MODEL ||
      DEFAULT_EMBED_MODEL_PATH,
    generationUrl: deps.generationUrl,
    embeddingUrl: deps.embeddingUrl,
    cacheDir:
      deps.cacheDir || process.env.CLAUDE_MEM_MODEL_DIR || DEFAULT_MODEL_DIR,
  };

  const generateText = async (
    messages: readonly ChatMessage[],
    tools?: readonly ToolDefinition[],
  ): Promise<string> => {
    const prompt = formatQwen3Prompt(messages, tools);

    const result = await serverGenerateText(config.generationUrl, prompt);

    if (!result.ok) {
      throw result.error;
    }

    return result.value;
  };

  const computeEmbedding = async (text: string): Promise<Float32Array> => {
    const result = await serverComputeEmbedding(config.embeddingUrl, text);

    if (!result.ok) {
      throw result.error;
    }

    return result.value;
  };

  const dispose = async (): Promise<void> => {
    // Server lifecycle is managed externally (main.ts / caller)
  };

  return {
    getConfig: () => config,
    generateText,
    computeEmbedding,
    dispose,
  };
};
