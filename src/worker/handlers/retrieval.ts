/**
 * Retrieval handlers: retrieve, get context, get observation.
 */

const isDev = process.env.NODE_ENV === "development";
const debug = isDev ? (...args: unknown[]) => console.debug(...args) : () => {};

import type { ObservationWithRank } from "../../db/index";
import {
  getCandidateObservations,
  getObservationById,
  getRecentSummaries,
  getSessionByClaudeId,
} from "../../db/index";
import { expandSeeds, queryGraph, SAME_PROJECT_BONUS } from "../../graph/index";
import {
  buildSearchMemoryPrompt,
  SEARCH_MEMORY_SEMANTIC_TOOL,
} from "../../models/prompts";
import { parseSmartSearchToolCall } from "../../models/tool-call-parser";
import { fromPromise } from "../../types/result";
import {
  formatContextFull,
  formatContextIndex,
  formatObservationFull,
} from "../../utils/context-formatter";
import { calculateRecencyScore } from "../../utils/relevance";
import { parseSince } from "../../utils/temporal";
import {
  enqueueMissingEmbeddings,
  type GetContextInput,
  type GetObservationInput,
  type HandlerResponse,
  type RetrieveInput,
  type WorkerDeps,
} from "./types";

/**
 * Retrieve relevant memories for a user prompt.
 * Uses the local model to extract search query, then graph-based retrieval:
 * embedding seeds -> spreading activation through knowledge graph.
 */
export const handleRetrieve = async (
  deps: WorkerDeps,
  input: RetrieveInput,
): Promise<HandlerResponse> => {
  const { prompt, project, limit, sessionId } = input;

  debug(
    `[retrieve] called prompt="${prompt?.slice(0, 80)}" project=${project} sessionId=${sessionId}`,
  );

  if (!prompt) {
    debug("[retrieve] EXIT: no prompt");
    return {
      status: 400,
      body: { error: "prompt is required" },
    };
  }

  // Skip retrieval on first prompt — SessionStart context is still fresh
  if (sessionId) {
    const sessionResult = getSessionByClaudeId(deps.db, sessionId);
    if (!sessionResult.ok || !sessionResult.value) {
      // Session not yet created — this is definitely the first prompt
      debug(`[retrieve] EXIT: session not found for ${sessionId}`);
      return {
        status: 200,
        body: { context: null, observationCount: 0, typeCounts: {} },
      };
    }
  }

  if (!deps.modelManager || !deps.graphManager) {
    debug("[retrieve] EXIT: modelManager or graphManager unavailable");
    return {
      status: 503,
      body: { error: "Model manager or graph manager unavailable" },
    };
  }

  // Use local model to decide whether retrieval is needed and extract query
  const searchPrompt = buildSearchMemoryPrompt(prompt);
  const generateResult = await fromPromise(
    deps.modelManager.generateText(
      [
        {
          role: "system",
          content:
            "You are a memory retrieval assistant. When the user asks a technical question, call the search_memory_semantic tool. Only skip the tool for greetings or confirmations.",
        },
        { role: "user", content: searchPrompt },
      ],
      [SEARCH_MEMORY_SEMANTIC_TOOL],
    ),
  );
  if (!generateResult.ok) {
    debug(
      `[retrieve] EXIT: model generation failed: ${generateResult.error.message}`,
    );
    return {
      status: 500,
      body: {
        error: `Model generation failed: ${generateResult.error.message}`,
      },
    };
  }
  const modelOutput = generateResult.value;
  debug(`[retrieve] modelOutput="${modelOutput.slice(0, 200)}"`);

  // Parse the smart tool call (fts, semantic, or legacy)
  const toolCall = parseSmartSearchToolCall(modelOutput);
  if (toolCall) {
    console.log(`[retrieve] mode=${toolCall.mode} query="${toolCall.query}"`);
  }
  if (!toolCall) {
    // Model decided prompt is not searchable (greeting, small talk, etc.)
    debug("[retrieve] EXIT: no tool call parsed from model output");
    return {
      status: 200,
      body: {
        context: null,
        observationCount: 0,
        typeCounts: {},
      },
    };
  }

  // Graph-based retrieval: embedding seeds -> spreading activation
  const searchResult = await queryGraph({
    db: deps.db,
    modelManager: deps.modelManager,
    graphManager: deps.graphManager,
    query: toolCall.query,
    project,
    limit,
  });

  if (!searchResult.ok) {
    return {
      status: 500,
      body: { error: searchResult.error.message },
    };
  }

  const observations = searchResult.value.observations;

  if (observations.length === 0) {
    return {
      status: 200,
      body: {
        context: null,
        observationCount: 0,
        typeCounts: {},
      },
    };
  }

  // Compute type counts
  const typeCounts: Record<string, number> = {};
  for (const obs of observations) {
    typeCounts[obs.type] = (typeCounts[obs.type] ?? 0) + 1;
  }

  // Format as index (same progressive disclosure format as SessionStart)
  const context = formatContextIndex(project, observations, []);

  return {
    status: 200,
    body: {
      context,
      observationCount: observations.length,
      typeCounts,
      searchMode: toolCall.mode,
    },
  };
};

/**
 * Get context for a project (recent observations and summaries).
 * Uses graph-based retrieval: recent observations as seeds -> spreading activation.
 * Supports progressive disclosure via format parameter (default: index).
 */
export const handleGetContext = async (
  deps: WorkerDeps,
  input: GetContextInput,
): Promise<HandlerResponse> => {
  const { project, limit, format = "index", since } = input;

  const sinceEpoch = parseSince(since);

  // Get recent observations across all projects as seed candidates
  const candidateLimit = limit * 3;
  const candidatesResult = getCandidateObservations(deps.db, {
    limit: candidateLimit,
  });

  if (!candidatesResult.ok) {
    return {
      status: 500,
      body: { error: candidatesResult.error.message },
    };
  }

  let candidates = candidatesResult.value;

  // Filter by since if provided
  if (sinceEpoch !== null) {
    candidates = candidates.filter((o) => o.createdAtEpoch >= sinceEpoch);
  }

  const crossProjectEnabled = process.env.GOLDFISH_CROSS_PROJECT !== "false";
  if (!crossProjectEnabled) {
    candidates = candidates.filter((o) => o.project === project);
  }

  // Score candidates by recency to use as seeds for graph traversal
  const halfLifeDays = Number.parseInt(
    process.env.GOLDFISH_RECENCY_HALFLIFE_DAYS || "2",
    10,
  );
  const halfLife = Number.isNaN(halfLifeDays) ? 2 : halfLifeDays;

  const seeds = candidates
    .map((c) => ({
      observationId: c.id,
      activation:
        calculateRecencyScore(c.createdAtEpoch, halfLife) +
        (c.project === project ? SAME_PROJECT_BONUS : 0),
    }))
    .sort((a, b) => b.activation - a.activation)
    .slice(0, limit);

  // Expand through graph
  const candidateMap = new Map(candidates.map((c) => [c.id, c]));
  const observations = deps.graphManager
    ? expandSeeds({
        db: deps.db,
        graphManager: deps.graphManager,
        seeds,
        candidateMap,
        limit,
      })
    : seeds
        .map((s) => candidateMap.get(s.observationId))
        .filter((o): o is ObservationWithRank => o !== undefined);

  // Enqueue embed messages for observations that lack embeddings
  if (deps.router) {
    const embeddedIds = new Set(
      candidates.filter((c) => c.hasEmbedding).map((c) => c.id),
    );
    enqueueMissingEmbeddings(deps.router, observations, embeddedIds);
  }

  // Compute type counts
  const typeCounts: Record<string, number> = {};
  for (const obs of observations) {
    typeCounts[obs.type] = (typeCounts[obs.type] ?? 0) + 1;
  }

  // Get summaries (still project-scoped)
  const summariesResult = getRecentSummaries(deps.db, { project, limit });
  if (!summariesResult.ok) {
    return {
      status: 500,
      body: { error: summariesResult.error.message },
    };
  }

  let summaries = summariesResult.value;
  if (sinceEpoch !== null) {
    summaries = summaries.filter((s) => s.createdAtEpoch >= sinceEpoch);
  }

  if (observations.length === 0 && summaries.length === 0) {
    return {
      status: 200,
      body: {
        context: `# ${project} recent context\n\nNo previous sessions found for this project yet.`,
        observationCount: 0,
        summaryCount: 0,
        typeCounts: {},
        format,
      },
    };
  }

  const context =
    format === "index"
      ? formatContextIndex(project, observations, summaries)
      : formatContextFull(project, observations, summaries);

  return {
    status: 200,
    body: {
      context,
      observationCount: observations.length,
      summaryCount: summaries.length,
      typeCounts,
      format,
    },
  };
};

/**
 * Get a single observation by ID (for on-demand detail loading).
 */
export const handleGetObservation = async (
  deps: WorkerDeps,
  input: GetObservationInput,
): Promise<HandlerResponse> => {
  const { id } = input;

  if (!id || id <= 0) {
    return {
      status: 400,
      body: { error: "Valid observation ID is required" },
    };
  }

  const result = getObservationById(deps.db, id);
  if (!result.ok) {
    return {
      status: 500,
      body: { error: result.error.message },
    };
  }

  if (!result.value) {
    return {
      status: 404,
      body: { error: `Observation ${id} not found` },
    };
  }

  return {
    status: 200,
    body: {
      observation: result.value,
      formatted: formatObservationFull(result.value),
    },
  };
};
