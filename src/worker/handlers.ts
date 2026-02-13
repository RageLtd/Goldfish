/**
 * HTTP handlers for the worker service.
 * Pure functions that take dependencies and input, return response objects.
 */

import type { Database } from "bun:sqlite";
import {
  createSession,
  getCandidateObservations,
  getObservationById,
  getRecentObservations,
  getRecentSummaries,
  getSessionByClaudeId,
  incrementPromptCounter,
  saveUserPrompt,
  searchObservations,
  searchSummaries,
  updateSessionStatus,
} from "../db/index";
import {
  formatContextFull,
  formatContextIndex,
  formatObservationFull,
} from "../utils/context-formatter";
import { type ScoringContext, scoreObservation } from "../utils/relevance";
import { parseSince } from "../utils/temporal";
import { escapeFts5Query, projectFromCwd } from "../utils/validation";
import type { SessionManager } from "./session-manager";

// ============================================================================
// Types
// ============================================================================

export interface WorkerDeps {
  readonly db: Database;
  readonly sessionManager?: SessionManager;
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

export interface QueuePromptInput {
  readonly claudeSessionId: string;
  readonly prompt: string;
  readonly cwd: string;
}

// ============================================================================
// Handlers
// ============================================================================

export interface HealthCheckResponse {
  readonly status: string;
  readonly version: string;
  readonly uptimeSeconds: number;
  readonly activeSessions: number;
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
  const activeSessions = deps.sessionManager?.getActiveSessions().length ?? 0;

  return {
    status: 200,
    body: {
      status: "ok",
      version: deps.version || "unknown",
      uptimeSeconds,
      activeSessions,
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

  let sessionId: number;
  const project = projectFromCwd(cwd);

  if (!sessionResult.value) {
    // Create session with minimal info
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
    sessionId = createResult.value.id;

    // Initialize in SessionManager if this is a new session
    if (createResult.value.isNew && deps.sessionManager) {
      deps.sessionManager.initializeSession(
        sessionId,
        claudeSessionId,
        project,
        "",
      );
    }
  } else {
    sessionId = sessionResult.value.id;

    // Ensure session is initialized in SessionManager (may have been created by another request)
    if (deps.sessionManager && !deps.sessionManager.getSession(sessionId)) {
      deps.sessionManager.initializeSession(
        sessionId,
        claudeSessionId,
        project,
        "",
      );
    }
  }

  // Queue observation in SessionManager if available
  if (deps.sessionManager) {
    deps.sessionManager.queueObservation(sessionId, {
      toolName,
      toolInput,
      toolResponse,
      cwd,
      occurredAt: new Date().toISOString(),
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
 * Queue a user prompt for processing.
 */
export const handleQueuePrompt = async (
  deps: WorkerDeps,
  input: QueuePromptInput,
): Promise<HandlerResponse> => {
  const { claudeSessionId, prompt, cwd } = input;

  // Validate required fields
  if (!claudeSessionId || !prompt) {
    return {
      status: 400,
      body: { error: "claudeSessionId and prompt are required" },
    };
  }

  // Get or create session
  const sessionResult = getSessionByClaudeId(deps.db, claudeSessionId);
  if (!sessionResult.ok) {
    return {
      status: 500,
      body: { error: sessionResult.error.message },
    };
  }

  let sessionId: number;
  let promptNumber: number;
  const project = projectFromCwd(cwd);

  if (!sessionResult.value) {
    // Try to create new session (handles race condition via INSERT OR IGNORE)
    const createResult = createSession(deps.db, {
      claudeSessionId,
      project,
      userPrompt: prompt,
    });

    if (!createResult.ok) {
      return {
        status: 500,
        body: { error: createResult.error.message },
      };
    }

    sessionId = createResult.value.id;

    // Use isNew to determine if this is truly a new session or we lost a race
    if (createResult.value.isNew) {
      promptNumber = 1;

      // Initialize in SessionManager if available
      if (deps.sessionManager) {
        deps.sessionManager.initializeSession(
          sessionId,
          claudeSessionId,
          project,
          prompt,
        );
      }
    } else {
      // Lost the race - session was created by another request
      // Treat as continuation
      const counterResult = incrementPromptCounter(deps.db, sessionId);
      if (!counterResult.ok) {
        return {
          status: 500,
          body: { error: counterResult.error.message },
        };
      }
      promptNumber = counterResult.value;

      // Queue continuation in SessionManager if available
      if (deps.sessionManager) {
        deps.sessionManager.queueContinuation(sessionId, prompt, promptNumber);
      }
    }
  } else {
    sessionId = sessionResult.value.id;

    // Increment counter for continuation prompt
    const counterResult = incrementPromptCounter(deps.db, sessionId);
    if (!counterResult.ok) {
      return {
        status: 500,
        body: { error: counterResult.error.message },
      };
    }
    promptNumber = counterResult.value;

    // Queue continuation in SessionManager if available
    if (deps.sessionManager) {
      deps.sessionManager.queueContinuation(sessionId, prompt, promptNumber);
    }
  }

  // Store the prompt
  const saveResult = saveUserPrompt(deps.db, {
    claudeSessionId,
    promptNumber,
    promptText: prompt,
  });

  if (!saveResult.ok) {
    return {
      status: 500,
      body: { error: saveResult.error.message },
    };
  }

  return {
    status: 200,
    body: {
      status: "stored",
      claudeSessionId,
      promptNumber,
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
  // transcriptPath is forwarded from the hook but not yet wired to the SDK agent.
  // Future: parse transcript to extract actual user/assistant messages.

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

  // Queue summarize in SessionManager if available
  if (deps.sessionManager) {
    deps.sessionManager.queueSummarize(
      sessionResult.value.id,
      lastUserMessage,
      lastAssistantMessage,
    );
  }

  // Queue summary request
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

  // Close session in SessionManager if available
  if (deps.sessionManager) {
    deps.sessionManager.closeSession(sessionResult.value.id);
  }

  // Update status
  const updateResult = updateSessionStatus(
    deps.db,
    sessionResult.value.id,
    "completed",
  );

  if (!updateResult.ok) {
    return {
      status: 500,
      body: { error: updateResult.error.message },
    };
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
  for (const c of candidates) {
    if (c.ftsRank !== 0) {
      ftsRanks.set(c.id, Math.abs(c.ftsRank));
    }
  }

  const halfLifeDays = Number.parseInt(
    process.env.CLAUDE_MEM_RECENCY_HALFLIFE_DAYS || "2",
    10,
  );
  const crossProjectEnabled = process.env.CLAUDE_MEM_CROSS_PROJECT !== "false";

  const scoringContext: ScoringContext = {
    currentProject: project,
    cwdFiles: [],
    ftsRanks,
    config: {
      recencyHalfLifeDays: Number.isNaN(halfLifeDays) ? 2 : halfLifeDays,
      sameProjectBonus: 0.1,
      ftsWeight: 1.0,
      conceptWeight: 0.5,
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

  // Escape query for FTS5 safety
  const escapedQuery = escapeFts5Query(query);

  if (type === "observations") {
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
      body: {
        results: result.value,
        count: result.value.length,
      },
    };
  }

  // type === 'summaries'
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
    body: {
      results: result.value,
      count: result.value.length,
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
