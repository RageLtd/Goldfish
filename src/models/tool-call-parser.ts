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
// Generic Tool Call Parser
// ============================================================================

export interface GenericToolCallResult {
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

/**
 * Parses any tool call from model output, returning raw arguments.
 * Use when the tool schema is not known at compile time.
 */
export const parseGenericToolCall = (
  text: string,
): GenericToolCallResult | null => {
  const extracted = extractToolCallJson(text);
  if (!extracted) return null;
  return { name: extracted.name, arguments: extracted.rawArgs };
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

// ============================================================================
// Smart Search Tool Call Parser
// ============================================================================

interface FtsSearchResult {
  readonly mode: "fts";
  readonly query: string;
}

interface SemanticSearchResult {
  readonly mode: "semantic";
  readonly query: string;
}

export type SearchModeResult = FtsSearchResult | SemanticSearchResult;

const SMART_SEARCH_NAMES = new Set([
  "search_memory_fts",
  "search_memory_semantic",
  "search_memory",
]);

/**
 * Parses a smart search tool call from model output.
 * Recognizes search_memory_fts, search_memory_semantic, and legacy search_memory.
 * Returns null if no tool call or prompt is not searchable.
 */
export const parseSmartSearchToolCall = (
  text: string,
): SearchModeResult | null => {
  const extracted = extractToolCallJson(text);
  if (!extracted || !SMART_SEARCH_NAMES.has(extracted.name)) return null;

  const { name, rawArgs } = extracted;

  if (typeof rawArgs.query !== "string" || rawArgs.query.trim() === "") {
    return null;
  }

  const query = rawArgs.query.trim();

  if (name === "search_memory_fts") {
    return { mode: "fts", query };
  }

  if (name === "search_memory_semantic") {
    return { mode: "semantic", query };
  }

  // Legacy search_memory — treat as FTS for backward compat
  return { mode: "fts", query };
};

// ============================================================================
// Graph Tool Call Parsers
// ============================================================================

export interface QueryGraphToolCall {
  readonly kind: "query_graph";
  readonly observationId: number;
}

export interface ClassifyRelationship {
  readonly sourceId: number;
  readonly targetId: number;
  readonly relationship: string;
  readonly direction: string;
  readonly strength: number;
  readonly explanation?: string;
}

export interface ClassifyRelationshipToolCall {
  readonly kind: "classify_relationship";
  readonly relationships: readonly ClassifyRelationship[];
}

export type GraphToolCall = QueryGraphToolCall | ClassifyRelationshipToolCall;

/**
 * Parses a graph tool call (query_graph or classify_relationship) from model output.
 * Returns null if no recognized graph tool call is found.
 */
export const parseGraphToolCall = (text: string): GraphToolCall | null => {
  const extracted = extractToolCallJson(text);
  if (!extracted) return null;

  const { name, rawArgs } = extracted;

  if (name === "query_graph") {
    const obsId = rawArgs.observation_id;
    if (typeof obsId !== "number" || !Number.isFinite(obsId)) return null;
    return { kind: "query_graph", observationId: obsId };
  }

  if (name === "classify_relationship") {
    if (!Array.isArray(rawArgs.relationships)) return null;

    const relationships: ClassifyRelationship[] = [];
    for (const item of rawArgs.relationships) {
      if (typeof item !== "object" || item === null) continue;
      const r = item as Record<string, unknown>;

      if (
        typeof r.source_id !== "number" ||
        typeof r.target_id !== "number" ||
        typeof r.relationship !== "string" ||
        typeof r.direction !== "string" ||
        typeof r.strength !== "number"
      ) {
        continue;
      }

      // Skip "none" relationships
      if (r.relationship === "none") continue;

      relationships.push({
        sourceId: r.source_id,
        targetId: r.target_id,
        relationship: r.relationship,
        direction: r.direction,
        strength: Math.max(0, Math.min(1, r.strength)),
        explanation:
          typeof r.explanation === "string" ? r.explanation : undefined,
      });
    }

    return { kind: "classify_relationship", relationships };
  }

  return null;
};
