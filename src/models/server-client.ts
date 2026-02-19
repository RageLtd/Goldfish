/**
 * HTTP client for llama-server /v1/completions and /v1/embeddings endpoints.
 * Sends pre-formatted prompts directly — no chat template processing here.
 */

import { err, ok, type Result } from "../types/result";

// ============================================================================
// Types
// ============================================================================

export interface CompletionConfig {
  readonly nPredict?: number;
  readonly temperature?: number;
  readonly topP?: number;
  readonly topK?: number;
  readonly minP?: number;
  readonly presencePenalty?: number;
  readonly stop?: readonly string[];
}

interface CompletionResponse {
  readonly choices: readonly { readonly text: string }[];
}

interface EmbeddingResponse {
  readonly data: readonly { readonly embedding: readonly number[] }[];
}

// ============================================================================
// Defaults
// ============================================================================

const DEFAULT_COMPLETION_CONFIG: Required<CompletionConfig> = {
  nPredict: 512,
  temperature: 0.7,
  topP: 0.8,
  topK: 20,
  minP: 0.0,
  presencePenalty: 1.0,
  stop: ["<|im_end|>", "[end of text]"],
};

// ============================================================================
// Client Functions
// ============================================================================

/**
 * Sends a pre-formatted prompt to /v1/completions and returns the generated text.
 * Strips stop sequences from output.
 */
export const serverGenerateText = async (
  url: string,
  prompt: string,
  config?: CompletionConfig,
): Promise<Result<string>> => {
  const merged = { ...DEFAULT_COMPLETION_CONFIG, ...config };

  const body = {
    prompt,
    n_predict: merged.nPredict,
    temperature: merged.temperature,
    top_p: merged.topP,
    top_k: merged.topK,
    min_p: merged.minP,
    presence_penalty: merged.presencePenalty,
    stop: [...merged.stop],
  };

  try {
    const response = await fetch(`${url}/v1/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      return err(
        new Error(`/v1/completions returned ${response.status}: ${text}`),
      );
    }

    const json = (await response.json()) as CompletionResponse;
    const raw = json.choices?.[0]?.text ?? "";

    // Trim stop sequences from output
    let output = raw.trim();
    for (const s of merged.stop) {
      const idx = output.indexOf(s);
      if (idx !== -1) {
        output = output.slice(0, idx);
      }
    }

    return ok(output.trim());
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }
};

/**
 * Sends text to /v1/embeddings and returns the embedding vector.
 */
export const serverComputeEmbedding = async (
  url: string,
  text: string,
): Promise<Result<Float32Array>> => {
  try {
    const response = await fetch(`${url}/v1/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: text }),
    });

    if (!response.ok) {
      const respText = await response.text();
      return err(
        new Error(`/v1/embeddings returned ${response.status}: ${respText}`),
      );
    }

    const json = (await response.json()) as EmbeddingResponse;
    const embedding = json.data?.[0]?.embedding ?? [];
    return ok(new Float32Array(embedding));
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }
};
