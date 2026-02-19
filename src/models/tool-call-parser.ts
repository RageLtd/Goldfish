/**
 * Parser for Qwen3 tool call output.
 * Extracts structured observation data from <tool_call> blocks.
 */

import { isObservationType, type ObservationType } from "../types/domain";

// ============================================================================
// Types
// ============================================================================

export interface ToolCallArguments {
  readonly type: ObservationType;
  readonly title: string;
  readonly subtitle?: string;
  readonly narrative: string;
  readonly facts?: readonly string[];
  readonly concepts?: readonly string[];
}

export interface ToolCallResult {
  readonly name: string;
  readonly arguments: ToolCallArguments;
}

export interface SearchToolCallArguments {
  readonly query: string;
}

export interface SearchToolCallResult {
  readonly name: string;
  readonly arguments: SearchToolCallArguments;
}

export interface SummaryToolCallArguments {
  readonly request?: string;
  readonly investigated?: string;
  readonly learned?: string;
  readonly completed?: string;
  readonly nextSteps?: string;
  readonly notes?: string;
}

export interface SummaryToolCallResult {
  readonly name: string;
  readonly arguments: SummaryToolCallArguments;
}

// ============================================================================
// Internal helpers
// ============================================================================

/**
 * Extracts a tool call JSON object from model output.
 * Parses bare JSON with "name" and "arguments" keys from /v1/completions output.
 */
const extractToolCallJson = (
  text: string,
): { name: string; rawArgs: Record<string, unknown> } | null => {
  const jsonStr = findToolCallJson(text);
  if (!jsonStr) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    return null;
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("name" in parsed) ||
    !("arguments" in parsed)
  ) {
    return null;
  }

  const { name, arguments: args } = parsed as {
    name: unknown;
    arguments: unknown;
  };

  if (typeof name !== "string" || typeof args !== "object" || args === null) {
    return null;
  }

  return { name, rawArgs: args as Record<string, unknown> };
};

/**
 * Finds the outermost JSON object containing "name" and "arguments" keys.
 */
const findToolCallJson = (text: string): string | null => {
  const start = text.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") depth--;
    if (depth === 0) {
      const candidate = text.slice(start, i + 1);
      if (candidate.includes('"name"') && candidate.includes('"arguments"')) {
        return candidate;
      }
      return null;
    }
  }
  return null;
};

// ============================================================================
// Observation Tool Call Parser
// ============================================================================

/**
 * Parses a create_observation tool call from model output.
 * Returns null if no tool call is present (model decided to skip)
 * or if the tool call is malformed.
 */
export const parseToolCall = (text: string): ToolCallResult | null => {
  const extracted = extractToolCallJson(text);
  if (!extracted) return null;

  const { name, rawArgs } = extracted;

  // Validate required fields
  if (
    typeof rawArgs.title !== "string" ||
    typeof rawArgs.narrative !== "string"
  ) {
    return null;
  }

  // Coerce type to valid ObservationType
  const rawType = typeof rawArgs.type === "string" ? rawArgs.type : "change";
  const type: ObservationType = isObservationType(rawType) ? rawType : "change";

  return {
    name: String(name),
    arguments: {
      type,
      title: rawArgs.title,
      subtitle:
        typeof rawArgs.subtitle === "string" ? rawArgs.subtitle : undefined,
      narrative: rawArgs.narrative,
      facts: Array.isArray(rawArgs.facts)
        ? rawArgs.facts.filter((f): f is string => typeof f === "string")
        : undefined,
      concepts: Array.isArray(rawArgs.concepts)
        ? rawArgs.concepts.filter((c): c is string => typeof c === "string")
        : undefined,
    },
  };
};

// ============================================================================
// Summary Tool Call Parser
// ============================================================================

/**
 * Parses a create_summary tool call from model output.
 * Returns null if no tool call is present or if the tool name
 * is not "create_summary".
 */
export const parseSummaryToolCall = (
  text: string,
): SummaryToolCallResult | null => {
  const extracted = extractToolCallJson(text);
  if (!extracted || extracted.name !== "create_summary") return null;

  const { rawArgs } = extracted;

  const optStr = (key: string): string | undefined =>
    typeof rawArgs[key] === "string" ? (rawArgs[key] as string) : undefined;

  return {
    name: "create_summary",
    arguments: {
      request: optStr("request"),
      investigated: optStr("investigated"),
      learned: optStr("learned"),
      completed: optStr("completed"),
      nextSteps: optStr("nextSteps"),
      notes: optStr("notes"),
    },
  };
};

// ============================================================================
// Search Tool Call Parser
// ============================================================================

/**
 * Parses a search_memory tool call from model output.
 * Returns null if no tool call is present (model decided prompt is not searchable)
 * or if the tool call is malformed.
 */
export const parseSearchToolCall = (
  text: string,
): SearchToolCallResult | null => {
  const extracted = extractToolCallJson(text);
  if (!extracted || extracted.name !== "search_memory") return null;

  const { rawArgs } = extracted;

  if (typeof rawArgs.query !== "string" || rawArgs.query.trim() === "") {
    return null;
  }

  return {
    name: "search_memory",
    arguments: {
      query: rawArgs.query.trim(),
    },
  };
};
