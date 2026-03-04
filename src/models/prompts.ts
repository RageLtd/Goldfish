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
// Knowledge Graph Tool Definitions
// ============================================================================

export const QUERY_GRAPH_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "query_graph",
    description:
      "Get the graph neighborhood of an observation. Returns connected observations and their edge types.",
    parameters: {
      type: "object",
      properties: {
        observation_id: {
          type: "number",
          description: "The ID of the observation to query",
        },
      },
      required: ["observation_id"],
    },
  },
};

export const CLASSIFY_RELATIONSHIP_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "classify_relationship",
    description: "Classify relationships between observations",
    parameters: {
      type: "object",
      properties: {
        relationships: {
          type: "array",
          items: {
            type: "object",
            properties: {
              source_id: {
                type: "number",
                description: "Source observation ID",
              },
              target_id: {
                type: "number",
                description: "Target observation ID",
              },
              relationship: {
                type: "string",
                enum: [
                  "caused-by",
                  "supersedes",
                  "implements",
                  "relates-to",
                  "none",
                ],
                description: "The type of relationship",
              },
              direction: {
                type: "string",
                enum: ["a-to-b", "b-to-a", "bidirectional"],
                description: "Direction of the relationship",
              },
              strength: {
                type: "number",
                description: "Confidence score 0-1",
              },
              explanation: {
                type: "string",
                description: "One sentence explanation of the relationship",
              },
            },
            required: [
              "source_id",
              "target_id",
              "relationship",
              "direction",
              "strength",
            ],
          },
          description: "List of classified relationships",
        },
      },
      required: ["relationships"],
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
  return `If the user prompt is a technical question, call search_memory_semantic. If it is a greeting or confirmation, respond normally.

Example — user asks "how does auth work?", you call:
<tool_call>
{"name": "search_memory_semantic", "arguments": {"query": "how does auth work"}}
</tool_call>

User prompt: ${prompt.slice(0, 500)}`;
};

export interface SummaryPromptInput {
  readonly lastUserMessage: string;
  readonly lastAssistantMessage?: string;
}

// ============================================================================
// Graph Enrichment Prompt
// ============================================================================

export interface GraphEnrichmentObservation {
  readonly id: number;
  readonly type: string;
  readonly title: string;
  readonly narrative: string;
}

/**
 * Builds system + user prompts for LLM-based edge classification (Tier 3).
 * The model receives a source observation and candidates, then uses
 * query_graph to inspect existing connections before calling
 * classify_relationship.
 */
export const buildGraphEnrichmentPrompt = (
  source: GraphEnrichmentObservation,
  candidates: readonly GraphEnrichmentObservation[],
): { readonly system: string; readonly user: string } => {
  const system = `You classify semantic relationships between developer observations in a knowledge graph.

You have two tools:
1. query_graph — look up existing graph neighbors for an observation (max 2 calls)
2. classify_relationship — classify relationships between the source and candidates (call exactly once)

Valid relationships: caused-by, supersedes, implements, relates-to, none
Valid directions: a-to-b (source→target), b-to-a (target→source), bidirectional
Strength: 0-1 confidence score. Only include relationships with strength >= 0.5.

First optionally query the graph for context, then classify.`;

  const formatObs = (obs: GraphEnrichmentObservation): string =>
    `[${obs.id}] (${obs.type}) ${obs.title}\n  ${obs.narrative.slice(0, 200)}`;

  const user = `Source observation:
${formatObs(source)}

Candidate observations:
${candidates.map(formatObs).join("\n\n")}

Classify the relationships between the source [${source.id}] and each candidate. Use query_graph first if you need context about existing connections.`;

  return { system, user };
};

export const buildLocalSummaryPrompt = (input: SummaryPromptInput): string => {
  return `Summarize what was accomplished. Call the create_summary tool with relevant fields.

User request: ${input.lastUserMessage}
${input.lastAssistantMessage ? `Assistant response: ${input.lastAssistantMessage}` : ""}

Fill in whichever fields apply: request, investigated, learned, completed, nextSteps, notes. Omit fields you have no information for.`;
};
