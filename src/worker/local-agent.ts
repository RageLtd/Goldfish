/**
 * Local agent for observation extraction using llama.cpp CLI.
 * Standalone functions for processing observations and summaries
 * through the local llama.cpp model, called by message-router.
 */

import type { Database } from "bun:sqlite";
import {
  findSimilarObservation,
  storeObservation,
  storeSummary,
} from "../db/index";
import type { ModelManager } from "../models/manager";
import {
  buildLocalObservationPrompt,
  buildLocalSummaryPrompt,
  buildLocalSystemPrompt,
  OBSERVATION_TOOL,
  SUMMARY_TOOL,
} from "../models/prompts";
import {
  parseSummaryToolCall,
  parseToolCall,
} from "../models/tool-call-parser";
import type {
  ParsedObservation,
  ParsedSummary,
  ToolObservation,
} from "../types/domain";
import { err, ok, type Result } from "../types/result";

// ============================================================================
// Types
// ============================================================================

export interface LocalAgentDeps {
  readonly db: Database;
  readonly modelManager: ModelManager;
}

export interface SessionContext {
  readonly claudeSessionId: string;
  readonly project: string;
  readonly promptNumber: number;
}

// ============================================================================
// Constants
// ============================================================================

/** Tools whose file_path or path field indicates a modified file */
const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** Tools whose file_path or path field indicates a read file */
const READ_TOOLS = new Set(["Read", "Grep", "Glob", "LS"]);

// ============================================================================
// Internal helpers
// ============================================================================

const log = (msg: string) => console.log(`[local-agent] ${msg}`);

/**
 * Extracts file paths deterministically from tool input.
 * Returns { filesRead, filesModified } based on tool name.
 */
const extractFilePaths = (
  toolName: string,
  toolInput: unknown,
): {
  readonly filesRead: readonly string[];
  readonly filesModified: readonly string[];
} => {
  const input =
    typeof toolInput === "object" && toolInput !== null
      ? (toolInput as Record<string, unknown>)
      : {};

  const filePath =
    typeof input.file_path === "string"
      ? input.file_path
      : typeof input.path === "string"
        ? input.path
        : null;

  if (!filePath) {
    return { filesRead: [], filesModified: [] };
  }

  if (WRITE_TOOLS.has(toolName)) {
    return { filesRead: [], filesModified: [filePath] };
  }

  if (READ_TOOLS.has(toolName)) {
    return { filesRead: [filePath], filesModified: [] };
  }

  // Unknown tool — default to filesRead
  return { filesRead: [filePath], filesModified: [] };
};

/**
 * Builds a ParsedSummary from the last user message and model response.
 * The request field captures what the user asked; completed captures the model's output.
 */
const buildSummaryFromResponse = (
  lastUserMessage: string | null,
  modelResponse: string,
): ParsedSummary => ({
  request: lastUserMessage || null,
  investigated: null,
  learned: null,
  completed: modelResponse.slice(0, 500) || null,
  nextSteps: null,
  notes: null,
});

// ============================================================================
// Standalone functions (used by message-router)
// ============================================================================

export const processObservation = async (
  deps: LocalAgentDeps,
  context: SessionContext,
  observation: ToolObservation,
): Promise<Result<number | null, Error>> => {
  const { db, modelManager } = deps;
  const systemPrompt = buildLocalSystemPrompt();
  const userPrompt = buildLocalObservationPrompt(observation);

  log(`Processing observation for tool=${observation.toolName}`);

  const response = await modelManager.generateText(
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    [OBSERVATION_TOOL],
  );

  const toolCall = parseToolCall(response);
  if (!toolCall) {
    log("Model skipped observation (no tool call)");
    return ok(null);
  }

  const args = toolCall.arguments;
  const { filesRead, filesModified } = extractFilePaths(
    observation.toolName,
    observation.toolInput,
  );

  const parsed: ParsedObservation = {
    type: args.type,
    title: args.title,
    subtitle: args.subtitle ?? null,
    narrative: args.narrative,
    facts: args.facts ?? [],
    concepts: args.concepts ?? [],
    filesRead,
    filesModified,
  };

  const dupCheck = findSimilarObservation(db, {
    project: context.project,
    title: parsed.title || "",
    withinMs: 3600000,
  });

  if (dupCheck.ok && dupCheck.value) {
    log(
      `Skipping duplicate: "${parsed.title}" (similar to #${dupCheck.value.id})`,
    );
    return ok(null);
  }

  const result = storeObservation(db, {
    claudeSessionId: context.claudeSessionId,
    project: context.project,
    observation: parsed,
    promptNumber: context.promptNumber,
    discoveryTokens: 0,
  });

  if (!result.ok) {
    return err(new Error(result.error.message));
  }

  log(`Observation stored with id=${result.value}`);
  return ok(result.value);
};

export const processSummary = async (
  deps: LocalAgentDeps,
  context: SessionContext,
  input: {
    readonly lastUserMessage: string;
    readonly lastAssistantMessage?: string;
  },
): Promise<Result<number, Error>> => {
  const { db, modelManager } = deps;
  const systemPrompt = buildLocalSystemPrompt();
  const userPrompt = buildLocalSummaryPrompt({
    lastUserMessage: input.lastUserMessage,
    lastAssistantMessage: input.lastAssistantMessage,
  });

  log("Processing summarize request");

  const response = await modelManager.generateText(
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    [SUMMARY_TOOL],
  );

  const toolCall = parseSummaryToolCall(response);
  const summary: ParsedSummary = toolCall
    ? {
        request: toolCall.arguments.request ?? null,
        investigated: toolCall.arguments.investigated ?? null,
        learned: toolCall.arguments.learned ?? null,
        completed: toolCall.arguments.completed ?? null,
        nextSteps: toolCall.arguments.nextSteps ?? null,
        notes: toolCall.arguments.notes ?? null,
      }
    : buildSummaryFromResponse(input.lastUserMessage || null, response);

  const result = storeSummary(db, {
    claudeSessionId: context.claudeSessionId,
    project: context.project,
    summary,
    promptNumber: context.promptNumber,
    discoveryTokens: 0,
  });

  if (!result.ok) {
    return err(new Error(result.error.message));
  }

  log(`Summary stored with id=${result.value}`);
  return ok(result.value);
};
