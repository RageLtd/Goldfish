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
