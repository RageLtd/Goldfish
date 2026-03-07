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
  searchObservationIds,
} from "../../db/index";
import { expandSeeds, queryGraph, SAME_PROJECT_BONUS } from "../../graph/index";
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

// ============================================================================
// FTS query helpers
// ============================================================================

const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "are",
  "but",
  "not",
  "you",
  "all",
  "can",
  "had",
  "her",
  "was",
  "one",
  "our",
  "out",
  "has",
  "have",
  "from",
  "been",
  "some",
  "them",
  "than",
  "its",
  "over",
  "such",
  "that",
  "with",
  "this",
  "will",
  "each",
  "make",
  "like",
  "does",
  "when",
  "what",
  "just",
  "how",
]);

/** Build a safe FTS5 OR query from a user prompt. Returns null if no usable terms. */
const buildFtsQuery = (prompt: string): string | null => {
  const words = prompt
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3)
    .filter((w) => !STOP_WORDS.has(w.toLowerCase()));
  if (words.length === 0) return null;
  return words.map((w) => `"${w}"`).join(" OR ");
};

/**
 * Retrieve relevant memories for a user prompt.
 * Uses the prompt directly as embedding query for graph-based retrieval:
 * embedding seeds -> spreading activation through knowledge graph.
 */
export const handleRetrieve = async (
  deps: WorkerDeps,
  input: RetrieveInput,
): Promise<HandlerResponse> => {
  const t0 = isDev ? performance.now() : 0;
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

  // Hybrid search: FTS5 keywords + embedding similarity
  debug(`[retrieve] hybrid search query="${prompt.slice(0, 80)}"`);
  const tQuery = isDev ? performance.now() : 0;

  // FTS5 keyword search (sub-millisecond, catches exact term matches)
  let ftsHits: ReadonlyMap<number, number> | undefined;
  const ftsQuery = buildFtsQuery(prompt);
  if (ftsQuery) {
    const ftsResult = searchObservationIds(deps.db, {
      query: ftsQuery,
      limit: limit * 2,
    });
    if (ftsResult.ok && ftsResult.value.size > 0) {
      ftsHits = ftsResult.value;
      debug(
        `[retrieve] FTS hits=${ftsHits.size} query="${ftsQuery.slice(0, 80)}"`,
      );
    }
  }
  const tFts = isDev ? performance.now() : 0;

  const searchResult = await queryGraph({
    db: deps.db,
    modelManager: deps.modelManager,
    graphManager: deps.graphManager,
    query: prompt,
    project,
    limit,
    embeddingCache: deps.embeddingCache,
    ftsHits,
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

  if (isDev) {
    const elapsed = performance.now() - t0;
    debug(
      `[retrieve] PERF total=${elapsed.toFixed(1)}ms fts=${(tFts - tQuery).toFixed(1)}ms graph=${(performance.now() - tFts).toFixed(1)}ms observations=${observations.length} ftsHits=${ftsHits?.size ?? 0}`,
    );
  }

  return {
    status: 200,
    body: {
      context,
      observationCount: observations.length,
      typeCounts,
      searchMode: ftsHits ? "hybrid" : "semantic",
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
  const t0 = isDev ? performance.now() : 0;
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

  if (isDev) {
    debug(
      `[getContext] PERF total=${(performance.now() - t0).toFixed(1)}ms observations=${observations.length} summaries=${summaries.length}`,
    );
  }

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
