/**
 * Pure functions for hook business logic.
 * Hooks are thin wrappers that call these functions.
 */

import type {
  HookOutput,
  PostToolUseInput,
  SessionEndInput,
  SessionStartInput,
  StopInput,
  UserPromptSubmitInput,
} from "../types/hooks";
import { createContextOutput, createSuccessOutput } from "../types/hooks";
import { fromPromise } from "../types/result";
import {
  cleanPrompt,
  isEntirelyPrivate,
  stripPrivateTags,
} from "../utils/tag-stripping";
import { projectFromCwd } from "../utils/validation";

// ============================================================================
// Types
// ============================================================================

export interface HookDeps {
  readonly fetch: typeof fetch;
  readonly workerUrl: string;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Extracts project name from cwd path (cross-platform).
 * Returns null if cwd is empty/undefined.
 */
const extractProject = (cwd?: string): string | null => {
  if (!cwd) return null;
  const name = projectFromCwd(cwd);
  return name === "unknown" ? null : name;
};

/**
 * Makes a POST request to the worker service.
 */
const postToWorker = async (
  deps: HookDeps,
  path: string,
  body: unknown,
): Promise<unknown> => {
  const response = await deps.fetch(`${deps.workerUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return response.json();
};

/**
 * Makes a GET request to the worker service.
 */
const getFromWorker = async (
  deps: HookDeps,
  path: string,
  params: Record<string, string>,
): Promise<unknown> => {
  const url = new URL(`${deps.workerUrl}${path}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  const response = await deps.fetch(url.toString());
  return response.json();
};

/**
 * Strips private tags from tool response if it's a string.
 */
const sanitizeToolResponse = (response: unknown): unknown => {
  if (typeof response === "string") {
    return stripPrivateTags(response);
  }
  return response;
};

// ============================================================================
// Tool Filtering
// ============================================================================

/**
 * Default tools that should never be forwarded to the worker.
 * These are trivial operations that don't produce meaningful observations.
 */
export const DEFAULT_SKIP_TOOLS = ["TodoRead", "TodoWrite", "LS"] as const;

/**
 * Returns the set of tool names to skip.
 * Reads from CLAUDE_MEM_SKIP_TOOLS env var (comma-separated) or uses defaults.
 */
export const getSkipTools = (): ReadonlySet<string> => {
  const envVar = process.env.CLAUDE_MEM_SKIP_TOOLS;
  if (envVar !== undefined) {
    return new Set(
      envVar
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
    );
  }
  return new Set(DEFAULT_SKIP_TOOLS);
};

/**
 * Measures the combined text length of tool input and response.
 * Objects are JSON-stringified; strings are measured directly.
 */
export const getContentLength = (
  toolInput: unknown,
  toolResponse: unknown,
): number => {
  const inputLen =
    typeof toolInput === "string"
      ? toolInput.length
      : JSON.stringify(toolInput ?? "").length;
  const responseLen =
    typeof toolResponse === "string"
      ? toolResponse.length
      : JSON.stringify(toolResponse ?? "").length;
  return inputLen + responseLen;
};

// ============================================================================
// Formatting Helpers
// ============================================================================

/**
 * Pluralizes a type name: "decision" → "decisions", "bugfix" → "bugfixes".
 * Handles common English rules for the type names we use.
 */
const pluralize = (word: string, count: number): string => {
  if (count === 1) return word;
  if (word.endsWith("x")) return `${word}es`;
  if (word.endsWith("y")) return `${word.slice(0, -1)}ies`;
  return `${word}s`;
};

/**
 * Builds a source-aware system message summarizing loaded context.
 *
 * Used by processContextHook to communicate what was loaded to the user.
 */
export const formatSystemMessage = (
  source: string | undefined,
  observationCount: number,
  summaryCount: number,
  typeCounts: Record<string, number>,
): string => {
  const hasObservations = observationCount > 0;
  const hasSummaries = summaryCount > 0;

  // Neither observations nor summaries
  if (!hasObservations && !hasSummaries) {
    return "[claude-mem] No previous context for this project";
  }

  // No observations but has summaries
  if (!hasObservations && hasSummaries) {
    const noun = pluralize("summary", summaryCount);
    return `[claude-mem] ${summaryCount} session ${noun} loaded`;
  }

  // Determine source prefix
  let prefix: string;
  switch (source) {
    case "clear":
      prefix = "[claude-mem] Fresh session \u2014 ";
      break;
    case "resume":
      prefix = "[claude-mem] Resumed \u2014 ";
      break;
    case "compact":
      prefix = "[claude-mem] Compacted \u2014 ";
      break;
    default:
      // "startup" or undefined
      prefix = "[claude-mem] ";
      break;
  }

  // Build type breakdown (only non-zero counts)
  const breakdown = Object.entries(typeCounts)
    .filter(([, count]) => count > 0)
    .map(([type, count]) => `${count} ${pluralize(type, count)}`)
    .join(", ");

  let message = `${prefix}${observationCount} memories loaded (${breakdown})`;

  // Append summaries if present
  if (hasSummaries) {
    const noun = pluralize("summary", summaryCount);
    message += ` + ${summaryCount} session ${noun}`;
  }

  return message;
};

// ============================================================================
// Hook Processors
// ============================================================================

/**
 * Processes SessionStart hook - fetches and injects context.
 * Uses progressive disclosure: loads lightweight index (~1,100 tokens)
 * instead of full content. Agent can fetch details on-demand via
 * /observation_by_id endpoint.
 */
export const processContextHook = async (
  deps: HookDeps,
  input: SessionStartInput,
): Promise<HookOutput> => {
  const project = extractProject(input.cwd);

  if (!project) {
    return createSuccessOutput();
  }

  const fetchResult = await fromPromise(
    getFromWorker(deps, "/context", {
      project,
      limit: "50", // Increased from 20 since index format is lightweight
      format: "index", // Progressive disclosure: load semantic index, not full content
    }),
  );

  if (!fetchResult.ok) {
    return createSuccessOutput();
  }

  const result = fetchResult.value as {
    context?: string;
    observationCount?: number;
    summaryCount?: number;
    typeCounts?: Record<string, number>;
    format?: string;
  };

  if (result.context?.trim()) {
    const systemMessage = formatSystemMessage(
      input.source,
      result.observationCount ?? 0,
      result.summaryCount ?? 0,
      result.typeCounts ?? {},
    );

    return createContextOutput(result.context, systemMessage);
  }

  return createSuccessOutput();
};

/**
 * Processes PostToolUse hook - queues observation.
 * Filters out trivial tools and observations with minimal content.
 */
export const processSaveHook = async (
  deps: HookDeps,
  input: PostToolUseInput,
): Promise<HookOutput> => {
  // Skip tools in the skip list
  const skipTools = getSkipTools();
  if (skipTools.has(input.tool_name)) {
    return createSuccessOutput();
  }

  // Skip observations with tiny combined content
  if (getContentLength(input.tool_input, input.tool_response) < 50) {
    return createSuccessOutput();
  }

  // Fire-and-forget: don't block Claude Code
  await fromPromise(
    postToWorker(deps, "/observation", {
      claudeSessionId: input.session_id,
      toolName: input.tool_name,
      toolInput: input.tool_input,
      toolResponse: sanitizeToolResponse(input.tool_response),
      cwd: input.cwd,
    }),
  );

  return createSuccessOutput();
};

/**
 * Processes UserPromptSubmit hook - stores prompt.
 */
export const processNewHook = async (
  deps: HookDeps,
  input: UserPromptSubmitInput,
): Promise<HookOutput> => {
  // Skip entirely private prompts
  if (isEntirelyPrivate(input.prompt)) {
    return createSuccessOutput();
  }

  const cleanedPrompt = cleanPrompt(input.prompt);

  // Fire-and-forget
  await fromPromise(
    postToWorker(deps, "/prompt", {
      claudeSessionId: input.session_id,
      prompt: cleanedPrompt,
      cwd: input.cwd,
    }),
  );

  return createSuccessOutput();
};

/**
 * Processes Stop hook - queues summary request.
 */
export const processSummaryHook = async (
  deps: HookDeps,
  input: StopInput,
): Promise<HookOutput> => {
  // Fire-and-forget
  await fromPromise(
    postToWorker(deps, "/summary", {
      claudeSessionId: input.session_id,
      transcriptPath: input.transcript_path || "",
      lastUserMessage: "",
      lastAssistantMessage: "",
    }),
  );

  return createSuccessOutput();
};

/**
 * Processes SessionEnd hook - marks session completed.
 */
export const processCleanupHook = async (
  deps: HookDeps,
  input: SessionEndInput,
): Promise<HookOutput> => {
  // Fire-and-forget
  await fromPromise(
    postToWorker(deps, "/complete", {
      claudeSessionId: input.session_id,
      reason: input.reason,
    }),
  );

  return createSuccessOutput();
};
