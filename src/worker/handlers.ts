/**
 * HTTP handlers for the worker service.
 * Pure functions that take dependencies and input, return response objects.
 */

const isDev = process.env.NODE_ENV === "development";
const debug = isDev ? (...args: unknown[]) => console.debug(...args) : () => {};

import type { Database } from "bun:sqlite";
import {
  createSession,
  getCandidateObservations,
  getEmbeddingsByIds,
  getObservationById,
  getObservationsWithEmbeddings,
  getObservationsWithoutEmbeddings,
  getRecentObservations,
  getRecentSummaries,
  getSessionByClaudeId,
  searchObservations,
  searchSummaries,
} from "../db/index";
import type { ModelManager } from "../models/manager";
import {
  buildSearchMemoryPrompt,
  SEARCH_MEMORY_SEMANTIC_TOOL,
} from "../models/prompts";
import { parseSmartSearchToolCall } from "../models/tool-call-parser";
import type { Observation } from "../types/domain";
import { fromPromise, ok, type Result } from "../types/result";
import {
  formatContextFull,
  formatContextIndex,
  formatObservationFull,
} from "../utils/context-formatter";
import {
  cosineSimilarity,
  DEFAULT_SCORING_CONFIG,
  type ScoringContext,
  scoreObservation,
} from "../utils/relevance";
import { parseSince } from "../utils/temporal";
import {
  escapeFts5Query,
  escapeFts5QueryOr,
  projectFromCwd,
} from "../utils/validation";
import {
  getLastPruneStats,
  type LastPruneStats,
  type MessageRouter,
} from "./message-router";

// ============================================================================
// Constants
// ============================================================================

/** Weights for FTS position vs embedding cosine similarity in re-ranking. */
export const FTS_WEIGHT = 0.6;
export const EMBEDDING_WEIGHT = 0.4;

/**
 * Minimum combined relevance score (0-1) for retrieval results.
 * Results below this threshold are filtered out to avoid injecting
 * weakly-related memories as noise.
 * Score = FTS_WEIGHT * ftsRank + EMBEDDING_WEIGHT * embeddingSimilarity + sameProjectBonus.
 */
export const RETRIEVE_MIN_RELEVANCE = 0.4;

/**
 * Additive bonus for observations from the same project as the query.
 * Applied during re-ranking so same-project results float above
 * equally-relevant cross-project results without excluding them.
 */
export const RETRIEVE_SAME_PROJECT_BONUS = 0.15;

// ============================================================================
// Internal helpers
// ============================================================================

/**
 * Enqueues embed messages for observations that lack embeddings.
 * Used by both handleGetContext and handleSearch to backfill lazily.
 */
const enqueueMissingEmbeddings = (
  router: MessageRouter,
  observations: readonly {
    readonly id: number;
    readonly sdkSessionId: string;
    readonly title: string | null;
    readonly narrative: string | null;
  }[],
  existingIds: Set<number>,
): void => {
  for (const obs of observations) {
    if (existingIds.has(obs.id) || !obs.title) continue;
    router.enqueue({
      type: "embed",
      claudeSessionId: obs.sdkSessionId,
      data: {
        observationId: obs.id,
        title: obs.title ?? "",
        narrative: obs.narrative ?? "",
      },
    });
  }
};

interface RerankInput {
  readonly db: Database;
  readonly modelManager: ModelManager;
  readonly router?: MessageRouter;
  readonly observations: readonly Observation[];
  readonly query: string;
  readonly project?: string;
  readonly limit: number;
}

interface RerankResult {
  readonly observations: readonly Observation[];
  readonly reranked: boolean;
}

/**
 * Re-ranks observations using embedding similarity combined with FTS position.
 * Applies same-project bonus and minimum relevance threshold.
 * Returns Result — callers must handle failure explicitly.
 */
const rerankWithEmbeddings = async (
  input: RerankInput,
): Promise<RerankResult> => {
  const { db, modelManager, router, observations, query, project, limit } =
    input;

  if (observations.length === 0) {
    return { observations: [], reranked: false };
  }

  const embeddingResult = await fromPromise(
    modelManager.computeEmbedding(query),
  );
  if (!embeddingResult.ok) {
    return { observations: observations.slice(0, limit), reranked: false };
  }

  const queryEmbedding = embeddingResult.value;
  const ids = observations.map((o) => o.id);
  const embeddingsResult = getEmbeddingsByIds(db, { ids });

  if (!embeddingsResult.ok) {
    return { observations: observations.slice(0, limit), reranked: false };
  }

  const embeddings = embeddingsResult.value;

  const scored = observations.map((obs, index) => {
    const ftsScore = 1 - index / observations.length;
    const stored = embeddings.get(obs.id);
    const embScore = stored ? cosineSimilarity(queryEmbedding, stored) : 0;
    const projectBonus =
      project && obs.project === project ? RETRIEVE_SAME_PROJECT_BONUS : 0;
    return {
      observation: obs,
      combined:
        FTS_WEIGHT * ftsScore + EMBEDDING_WEIGHT * embScore + projectBonus,
    };
  });

  scored.sort((a, b) => b.combined - a.combined);

  const ranked = scored
    .filter((s) => s.combined >= RETRIEVE_MIN_RELEVANCE)
    .slice(0, limit)
    .map((s) => s.observation);

  // Enqueue missing embeddings for backfill
  if (router) {
    enqueueMissingEmbeddings(router, observations, new Set(embeddings.keys()));
  }

  return { observations: ranked, reranked: true };
};

// ============================================================================
// Shared Search + Rerank Pipeline
// ============================================================================

export interface SearchAndRankInput {
  readonly db: Database;
  readonly modelManager: ModelManager;
  readonly router?: MessageRouter;
  readonly query: string;
  readonly project?: string;
  readonly concept?: string;
  readonly limit: number;
  readonly escapeMode: "or" | "exact";
}

export interface SearchAndRankResult {
  readonly observations: readonly Observation[];
  readonly reranked: boolean;
}

/**
 * Shared FTS5 search → embedding rerank pipeline.
 * Used by both handleRetrieve (or-mode) and handleSearch (exact-mode).
 */
export const searchAndRank = async (
  input: SearchAndRankInput,
): Promise<Result<SearchAndRankResult>> => {
  const {
    db,
    modelManager,
    router,
    query,
    project,
    concept,
    limit,
    escapeMode,
  } = input;

  const escapedQuery =
    escapeMode === "or" ? escapeFts5QueryOr(query) : escapeFts5Query(query);

  const fetchLimit = limit * 3;
  const searchResult = searchObservations(db, {
    query: escapedQuery,
    concept,
    project,
    limit: fetchLimit,
  });

  if (!searchResult.ok) {
    return searchResult;
  }

  const reranked = await rerankWithEmbeddings({
    db,
    modelManager,
    router,
    observations: searchResult.value,
    query,
    project,
    limit,
  });

  return ok({
    observations: reranked.observations,
    reranked: reranked.reranked,
  });
};

// ============================================================================
// Semantic Search
// ============================================================================

export interface SemanticSearchInput {
  readonly db: Database;
  readonly modelManager: ModelManager;
  readonly router?: MessageRouter;
  readonly query: string;
  readonly project?: string;
  readonly limit: number;
}

/**
 * Pure embedding-based search — computes query embedding and ranks by cosine similarity.
 * No FTS5 dependency. Finds conceptually related memories regardless of keyword overlap.
 */
export const semanticSearch = async (
  input: SemanticSearchInput,
): Promise<Result<SearchAndRankResult>> => {
  const { db, modelManager, router, query, project, limit } = input;

  const embeddingResult = await fromPromise(
    modelManager.computeEmbedding(query),
  );
  if (!embeddingResult.ok) {
    return embeddingResult;
  }

  const queryEmbedding = embeddingResult.value;
  const candidatesResult = getObservationsWithEmbeddings(db, {});

  if (!candidatesResult.ok) {
    return candidatesResult;
  }

  const candidates = candidatesResult.value;
  debug(
    `[semantic] candidates=${candidates.length} query="${query.slice(0, 60)}"`,
  );

  const scored = candidates.map((c) => {
    const similarity = cosineSimilarity(queryEmbedding, c.embedding);
    const projectBonus =
      project && c.project === project ? RETRIEVE_SAME_PROJECT_BONUS : 0;
    return { candidate: c, score: similarity + projectBonus };
  });

  scored.sort((a, b) => b.score - a.score);

  if (isDev && scored.length > 0) {
    const top5 = scored
      .slice(0, 5)
      .map((s) => `${s.score.toFixed(3)}`)
      .join(", ");
    debug(
      `[semantic] top scores: [${top5}] min_relevance=${RETRIEVE_MIN_RELEVANCE}`,
    );
  }

  const filtered = scored
    .filter((s) => s.score >= RETRIEVE_MIN_RELEVANCE)
    .slice(0, limit);
  debug(`[semantic] filtered=${filtered.length} (limit=${limit})`);

  // Convert back to Observation shape
  const observations: Observation[] = filtered.map((s) => ({
    id: s.candidate.id,
    sdkSessionId: s.candidate.sdkSessionId,
    project: s.candidate.project,
    type: s.candidate.type as Observation["type"],
    title: s.candidate.title,
    subtitle: null,
    narrative: s.candidate.narrative,
    facts: [],
    concepts: [],
    filesRead: [],
    filesModified: [],
    promptNumber: 0,
    discoveryTokens: 0,
    createdAt: "",
    createdAtEpoch: s.candidate.createdAtEpoch,
  }));

  // Enqueue embeddings for candidates without (shouldn't happen but safety)
  if (router) {
    const existingIds = new Set(candidates.map((c) => c.id));
    enqueueMissingEmbeddings(router, observations, existingIds);
  }

  return ok({ observations, reranked: true });
};

// ============================================================================
// Types
// ============================================================================

export interface WorkerDeps {
  readonly db: Database;
  readonly router?: MessageRouter;
  readonly modelManager?: ModelManager;
  readonly startedAt?: number;
  readonly version?: string;
}

export interface HandlerResponse<T = unknown> {
  readonly status: number;
  readonly body: T;
}

// Input types for handlers
export interface QueueObservationInput {
  readonly claudeSessionId: string;
  readonly toolName: string;
  readonly toolInput: unknown;
  readonly toolResponse: unknown;
  readonly cwd: string;
}

export interface QueueSummaryInput {
  readonly claudeSessionId: string;
  readonly lastUserMessage: string;
  readonly lastAssistantMessage: string;
  readonly transcriptPath?: string;
}

export interface CompleteSessionInput {
  readonly claudeSessionId: string;
  readonly reason: string;
}

export type ContextFormat = "index" | "full";

export interface GetContextInput {
  readonly project: string;
  readonly limit: number;
  readonly format?: ContextFormat;
  readonly since?: string;
}

export interface SearchInput {
  readonly query: string;
  readonly type: "observations" | "summaries";
  readonly concept?: string;
  readonly project?: string;
  readonly limit: number;
  readonly format?: ContextFormat;
}

export interface TimelineInput {
  readonly project?: string;
  readonly limit: number;
  readonly since?: string;
}

export interface DecisionsInput {
  readonly project?: string;
  readonly limit: number;
  readonly since?: string;
}

export interface GetObservationInput {
  readonly id: number;
}

export interface FindByFileInput {
  readonly file: string;
  readonly limit: number;
}

export interface RetrieveInput {
  readonly prompt: string;
  readonly project: string;
  readonly limit: number;
  readonly sessionId?: string;
}

// ============================================================================
// Handlers
// ============================================================================

export interface HealthCheckResponse {
  readonly status: string;
  readonly version: string;
  readonly uptimeSeconds: number;
  readonly pendingMessages: number;
  readonly lastPrune: LastPruneStats | null;
}

/**
 * Health check endpoint with metadata.
 */
export const handleHealth = async (
  deps: WorkerDeps,
): Promise<HandlerResponse<HealthCheckResponse>> => {
  const now = Date.now();
  const uptimeSeconds = deps.startedAt
    ? Math.floor((now - deps.startedAt) / 1000)
    : 0;
  const pendingMessages = deps.router?.pending() ?? 0;

  return {
    status: 200,
    body: {
      status: "ok",
      version: deps.version || "unknown",
      uptimeSeconds,
      pendingMessages,
      lastPrune: getLastPruneStats(),
    },
  };
};

/**
 * Queue an observation from a tool use.
 */
export const handleQueueObservation = async (
  deps: WorkerDeps,
  input: QueueObservationInput,
): Promise<HandlerResponse> => {
  const { claudeSessionId, toolName, toolInput, toolResponse, cwd } = input;

  // Validate required fields
  if (!claudeSessionId) {
    return {
      status: 400,
      body: { error: "claudeSessionId is required" },
    };
  }

  // Ensure session exists (create if not)
  const sessionResult = getSessionByClaudeId(deps.db, claudeSessionId);
  if (!sessionResult.ok) {
    return {
      status: 500,
      body: { error: sessionResult.error.message },
    };
  }

  const project = projectFromCwd(cwd);

  if (!sessionResult.value) {
    const createResult = createSession(deps.db, {
      claudeSessionId,
      project,
      userPrompt: "",
    });

    if (!createResult.ok) {
      return {
        status: 500,
        body: { error: createResult.error.message },
      };
    }
  }

  // Enqueue for background processing
  if (deps.router) {
    deps.router.enqueue({
      type: "observation",
      claudeSessionId,
      data: { toolName, toolInput, toolResponse, cwd },
    });
  }

  return {
    status: 200,
    body: {
      status: "queued",
      claudeSessionId,
      toolName,
    },
  };
};

/**
 * Retrieve relevant memories for a user prompt.
 * Uses the local model to extract search keywords, then queries FTS5
 * with optional embedding re-ranking.
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

  if (!deps.modelManager) {
    debug("[retrieve] EXIT: no modelManager");
    return {
      status: 503,
      body: { error: "Model manager unavailable" },
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

  // Always use semantic (embedding-based) search for retrieval
  const searchResult = await semanticSearch({
    db: deps.db,
    modelManager: deps.modelManager,
    router: deps.router,
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
      reranked: searchResult.value.reranked,
    },
  };
};

/**
 * Queue a summary request.
 */
export const handleQueueSummary = async (
  deps: WorkerDeps,
  input: QueueSummaryInput,
): Promise<HandlerResponse> => {
  const { claudeSessionId, lastUserMessage, lastAssistantMessage } = input;

  // Validate session exists
  const sessionResult = getSessionByClaudeId(deps.db, claudeSessionId);
  if (!sessionResult.ok) {
    return {
      status: 500,
      body: { error: sessionResult.error.message },
    };
  }

  if (!sessionResult.value) {
    return {
      status: 404,
      body: { error: "Session not found" },
    };
  }

  // Enqueue for background processing
  if (deps.router) {
    deps.router.enqueue({
      type: "summarize",
      claudeSessionId,
      data: { lastUserMessage, lastAssistantMessage },
    });
  }

  return {
    status: 200,
    body: {
      status: "queued",
      claudeSessionId,
    },
  };
};

/**
 * Mark a session as completed.
 */
export const handleCompleteSession = async (
  deps: WorkerDeps,
  input: CompleteSessionInput,
): Promise<HandlerResponse> => {
  const { claudeSessionId, reason } = input;

  // Get session
  const sessionResult = getSessionByClaudeId(deps.db, claudeSessionId);
  if (!sessionResult.ok) {
    return {
      status: 500,
      body: { error: sessionResult.error.message },
    };
  }

  if (!sessionResult.value) {
    return {
      status: 404,
      body: { error: "Session not found" },
    };
  }

  // Enqueue completion for background processing
  if (deps.router) {
    deps.router.enqueue({
      type: "complete",
      claudeSessionId,
      data: { reason },
    });
  }

  return {
    status: 200,
    body: {
      status: "completed",
      claudeSessionId,
      reason,
    },
  };
};

/**
 * Get context for a project (recent observations and summaries).
 * Uses cross-project retrieval with relevance scoring.
 * Supports progressive disclosure via format parameter (default: index).
 */
export const handleGetContext = async (
  deps: WorkerDeps,
  input: GetContextInput,
): Promise<HandlerResponse> => {
  const { project, limit, format = "index", since } = input;

  const sinceEpoch = parseSince(since);

  // Get candidates from ALL projects (3x limit for re-ranking headroom)
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

  // Build scoring context
  const ftsRanks = new Map<number, number>();
  const embeddingScores = new Map<number, number>();
  for (const c of candidates) {
    if (c.ftsRank !== 0) {
      ftsRanks.set(c.id, Math.abs(c.ftsRank));
    }
    if (c.hasEmbedding) {
      embeddingScores.set(c.id, 1.0);
    }
  }

  const halfLifeDays = Number.parseInt(
    process.env.GOLDFISH_RECENCY_HALFLIFE_DAYS || "2",
    10,
  );
  const crossProjectEnabled = process.env.GOLDFISH_CROSS_PROJECT !== "false";

  const scoringContext: ScoringContext = {
    currentProject: project,
    cwdFiles: [],
    ftsRanks,
    embeddingScores,
    config: {
      ...DEFAULT_SCORING_CONFIG,
      recencyHalfLifeDays: Number.isNaN(halfLifeDays) ? 2 : halfLifeDays,
    },
  };

  // Score and sort
  const scored = candidates
    .filter((o) => crossProjectEnabled || o.project === project)
    .map((obs) => ({
      observation: obs,
      score: scoreObservation(obs, scoringContext),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  const observations = scored.map((s) => s.observation);

  // Enqueue embed messages for returned observations that lack embeddings
  if (deps.router) {
    const embeddedIds = new Set(embeddingScores.keys());
    enqueueMissingEmbeddings(deps.router, observations, embeddedIds);
  }

  // Compute type counts from scored/filtered observations
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

/**
 * Search observations or summaries.
 * When searching observations, an optional concept parameter filters by taxonomy.
 */
export const handleSearch = async (
  deps: WorkerDeps,
  input: SearchInput,
): Promise<HandlerResponse> => {
  const { query, type, concept, project, limit } = input;

  // Validate type
  if (type !== "observations" && type !== "summaries") {
    return {
      status: 400,
      body: {
        error: `Invalid type: ${type}. Must be 'observations' or 'summaries'`,
      },
    };
  }

  // Validate concept usage - only supported for observations
  if (concept && type === "summaries") {
    return {
      status: 400,
      body: {
        error: "concept parameter is only supported for type=observations",
      },
    };
  }

  if (type === "summaries") {
    const escapedQuery = escapeFts5Query(query);
    const result = searchSummaries(deps.db, {
      query: escapedQuery,
      project,
      limit,
    });
    if (!result.ok) {
      return {
        status: 500,
        body: { error: result.error.message },
      };
    }
    return {
      status: 200,
      body: { results: result.value, count: result.value.length },
    };
  }

  // type === "observations" — use searchAndRank if model available, else plain FTS
  if (!deps.modelManager) {
    const escapedQuery = escapeFts5Query(query);
    const result = searchObservations(deps.db, {
      query: escapedQuery,
      concept,
      project,
      limit,
    });
    if (!result.ok) {
      return {
        status: 500,
        body: { error: result.error.message },
      };
    }
    return {
      status: 200,
      body: { results: result.value, count: result.value.length },
    };
  }

  const rankResult = await searchAndRank({
    db: deps.db,
    modelManager: deps.modelManager,
    router: deps.router,
    query,
    concept,
    project,
    limit,
    escapeMode: "exact",
  });

  if (!rankResult.ok) {
    return {
      status: 500,
      body: { error: rankResult.error.message },
    };
  }

  return {
    status: 200,
    body: {
      results: rankResult.value.observations,
      count: rankResult.value.observations.length,
    },
  };
};

/**
 * Get a chronological timeline of recent observations and summaries.
 */
export const handleGetTimeline = async (
  deps: WorkerDeps,
  input: TimelineInput,
): Promise<HandlerResponse> => {
  const { project, limit, since } = input;

  // Parse since filter if provided
  const sinceEpoch = parseSince(since);

  const obsResult = getRecentObservations(deps.db, { project, limit });
  const sumResult = getRecentSummaries(deps.db, { project, limit });

  if (!obsResult.ok) {
    return {
      status: 500,
      body: { error: obsResult.error.message },
    };
  }

  if (!sumResult.ok) {
    return {
      status: 500,
      body: { error: sumResult.error.message },
    };
  }

  // Filter by since if provided
  let observations = obsResult.value;
  let summaries = sumResult.value;

  if (sinceEpoch !== null) {
    observations = observations.filter((o) => o.createdAtEpoch >= sinceEpoch);
    summaries = summaries.filter((s) => s.createdAtEpoch >= sinceEpoch);
  }

  // Merge and sort by epoch
  const items = [
    ...observations.map((o) => ({
      epoch: o.createdAtEpoch,
      kind: "observation" as const,
      type: o.type,
      title: o.title || "Untitled",
      narrative: o.narrative || o.subtitle,
    })),
    ...summaries.map((s) => ({
      epoch: s.createdAtEpoch,
      kind: "summary" as const,
      type: "summary",
      title: s.request || "Untitled",
      narrative: s.completed,
    })),
  ]
    .sort((a, b) => b.epoch - a.epoch)
    .slice(0, limit);

  return {
    status: 200,
    body: {
      results: items,
      count: items.length,
    },
  };
};

/**
 * Get architectural and design decisions.
 */
export const handleGetDecisions = async (
  deps: WorkerDeps,
  input: DecisionsInput,
): Promise<HandlerResponse> => {
  const { project, limit, since } = input;

  // Parse since filter if provided
  const sinceEpoch = parseSince(since);

  // Get more observations than needed, then filter for decisions
  const result = getRecentObservations(deps.db, { project, limit: limit * 5 });
  if (!result.ok) {
    return {
      status: 500,
      body: { error: result.error.message },
    };
  }

  let decisions = result.value.filter((o) => o.type === "decision");

  // Filter by since if provided
  if (sinceEpoch !== null) {
    decisions = decisions.filter((o) => o.createdAtEpoch >= sinceEpoch);
  }

  return {
    status: 200,
    body: {
      results: decisions.slice(0, limit),
      count: decisions.slice(0, limit).length,
    },
  };
};

/**
 * Find observations related to a specific file.
 */
export const handleFindByFile = async (
  deps: WorkerDeps,
  input: FindByFileInput,
): Promise<HandlerResponse> => {
  const { file, limit } = input;

  if (!file) {
    return {
      status: 400,
      body: { error: "file parameter is required" },
    };
  }

  // Use FTS5 with escaped query for indexed search
  const escapedQuery = escapeFts5Query(file);
  const result = searchObservations(deps.db, {
    query: escapedQuery,
    limit: limit * 3,
  });
  if (!result.ok) {
    return {
      status: 500,
      body: { error: result.error.message },
    };
  }

  // Filter to observations that actually reference this file in file arrays
  const matching = result.value
    .filter(
      (o) =>
        o.filesRead.some((f) => f.includes(file)) ||
        o.filesModified.some((f) => f.includes(file)),
    )
    .slice(0, limit);

  return {
    status: 200,
    body: {
      results: matching,
      count: matching.length,
    },
  };
};

/**
 * Enqueue embedding computation for observations that lack embeddings.
 * Fire-and-forget — returns immediately after enqueuing.
 */
export const handleBackfill = async (
  deps: WorkerDeps,
): Promise<HandlerResponse> => {
  const batchResult = getObservationsWithoutEmbeddings(deps.db, { limit: 500 });
  if (!batchResult.ok) {
    return { status: 500, body: { error: batchResult.error.message } };
  }

  const batch = batchResult.value;
  if (!deps.router || batch.length === 0) {
    return { status: 200, body: { enqueued: 0 } };
  }

  for (const obs of batch) {
    deps.router.enqueue({
      type: "embed",
      claudeSessionId: "",
      data: {
        observationId: obs.id,
        title: obs.title ?? "",
        narrative: obs.narrative ?? "",
      },
    });
  }

  return { status: 200, body: { enqueued: batch.length } };
};

/**
 * Graceful shutdown endpoint.
 * Returns immediately, then triggers shutdown via callback.
 */
export const handleShutdown = async (
  _deps: WorkerDeps,
  onShutdown: () => void,
): Promise<HandlerResponse<{ readonly status: string }>> => {
  // Schedule shutdown after response is sent
  setTimeout(onShutdown, 50);
  return {
    status: 200,
    body: { status: "shutting_down" },
  };
};

/**
 * Check how many observations still lack embeddings.
 */
export const handleBackfillStatus = async (
  deps: WorkerDeps,
): Promise<HandlerResponse> => {
  const result = getObservationsWithoutEmbeddings(deps.db, { limit: 10000 });
  if (!result.ok) {
    return { status: 500, body: { error: result.error.message } };
  }

  return {
    status: 200,
    body: {
      remaining: result.value.length,
      pendingMessages: deps.router?.pending() ?? 0,
    },
  };
};
