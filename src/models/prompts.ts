/**
 * Prompts for local model inference.
 * Reuses observation quality guidelines from the SDK agent,
 * adapted for small model consumption with tool calling.
 */

import type { ToolObservation } from "../types/domain";
import type { ToolDefinition } from "./manager";

// ============================================================================
// Tool Definitions
// ============================================================================

export const OBSERVATION_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "create_observation",
    description:
      "Record a meaningful observation from a tool execution. Only call this for non-trivial work.",
    parameters: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: [
            "bugfix",
            "feature",
            "refactor",
            "change",
            "discovery",
            "decision",
          ],
          description:
            "bugfix: something broken now fixed. feature: new capability. refactor: restructured, behavior unchanged. change: generic modification. discovery: learning about existing system. decision: architectural choice.",
        },
        title: {
          type: "string",
          description: "Short title capturing the core action (~80 chars)",
        },
        subtitle: {
          type: "string",
          description: "One sentence explanation (max 24 words)",
        },
        narrative: {
          type: "string",
          description:
            "Full context: what was done, how it works, why it matters",
        },
        facts: {
          type: "array",
          items: { type: "string" },
          description: "Concise, self-contained factual statements",
        },
        concepts: {
          type: "array",
          items: {
            type: "string",
            enum: [
              "how-it-works",
              "why-it-exists",
              "what-changed",
              "problem-solution",
              "gotcha",
              "pattern",
              "trade-off",
            ],
          },
          description: "Concept tags categorizing this observation",
        },
      },
      required: ["type", "title", "narrative"],
    },
  },
};

export const SUMMARY_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "create_summary",
    description:
      "Record a progress summary of what was accomplished in this session.",
    parameters: {
      type: "object",
      properties: {
        request: {
          type: "string",
          description: "What the user asked for",
        },
        investigated: {
          type: "string",
          description: "What was investigated or explored",
        },
        learned: {
          type: "string",
          description: "Key learnings or insights",
        },
        completed: {
          type: "string",
          description: "What was accomplished",
        },
        nextSteps: {
          type: "string",
          description: "Suggested follow-up actions",
        },
        notes: {
          type: "string",
          description: "Additional notes or context",
        },
      },
      required: [],
    },
  },
};

export const SEARCH_MEMORY_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "search_memory",
    description:
      "Search for relevant memories matching the user's prompt. Call with a concise search query.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Concise search keywords extracted from the user's prompt (2-5 words)",
        },
      },
      required: ["query"],
    },
  },
};

export const SEARCH_MEMORY_FTS_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "search_memory_fts",
    description:
      "Search memories by keywords. Use for specific terms, error messages, file names, function names.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Concise search keywords (2-5 words)",
        },
      },
      required: ["query"],
    },
  },
};

export const SEARCH_MEMORY_SEMANTIC_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "search_memory_semantic",
    description:
      "Search memories by meaning. Use for conceptual questions about how things work, why decisions were made, or finding similar past work.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Natural language description of what to find",
        },
      },
      required: ["query"],
    },
  },
};

// ============================================================================
// System Prompt
// ============================================================================

export const buildLocalSystemPrompt = (): string => {
  return `You are an observer that records what happens during a developer session.

When you receive a tool execution notification, decide if it represents meaningful work. If yes, call the create_observation tool. If the operation is trivial (empty file checks, basic listings, simple installs), do NOT call the tool.

Record OUTCOMES and INSIGHTS, not just actions:
- Bug investigations: root cause, what was found
- Fixes: what was broken and how it was fixed (bugfix)
- Features: new functionality added
- Decisions: architectural choices, trade-offs
- A discovery about how code works, why something behaves a certain way

Use past tense: discovered, fixed, implemented, learned.

Good: "Fixed missing await on getToken() causing auth failures downstream"
Bad: "Analyzed the code and recorded findings"

Be concise. Title under 80 characters. Narrative under 200 words. Omit filler — every word should convey useful information.`;
};

// ============================================================================
// Per-message Prompts
// ============================================================================

export const buildLocalObservationPrompt = (
  observation: ToolObservation,
): string => {
  const { toolName, toolInput, toolResponse } = observation;

  const inputSummary =
    typeof toolInput === "object" && toolInput !== null
      ? JSON.stringify(toolInput, null, 2).slice(0, 1000)
      : String(toolInput).slice(0, 1000);

  const responseSummary =
    typeof toolResponse === "string"
      ? toolResponse.slice(0, 500)
      : JSON.stringify(toolResponse, null, 2).slice(0, 500);

  return `Tool: ${toolName}
Input: ${inputSummary}
Result: ${responseSummary}`;
};

export const buildSearchMemoryPrompt = (prompt: string): string => {
  return `You have two search tools. Default to search_memory_semantic unless the prompt contains specific exact terms.

- search_memory_semantic (DEFAULT): Search by meaning. Use for most prompts — questions, descriptions, conceptual queries, "how does X work", "why did we choose Y", finding related past work.
- search_memory_fts: Search by exact keywords. Use ONLY when the prompt contains specific file names, error messages, function names, or exact technical terms that must match literally.

If the prompt is a greeting, small talk, or has no searchable content, do NOT call any tool.

User prompt: ${prompt.slice(0, 500)}`;
};

export interface SummaryPromptInput {
  readonly lastUserMessage: string;
  readonly lastAssistantMessage?: string;
}

export const buildLocalSummaryPrompt = (input: SummaryPromptInput): string => {
  return `Summarize what was accomplished. Call the create_summary tool with relevant fields.

User request: ${input.lastUserMessage}
${input.lastAssistantMessage ? `Assistant response: ${input.lastAssistantMessage}` : ""}

Fill in whichever fields apply: request, investigated, learned, completed, nextSteps, notes. Omit fields you have no information for.`;
};
