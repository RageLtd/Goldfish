/**
 * Search handlers: search, timeline, decisions, find by file.
 */

import {
  getRecentObservations,
  getRecentSummaries,
  searchObservations,
  searchSummaries,
} from "../../db/index";
import { expandSeeds, queryGraph } from "../../graph/index";
import { calculateRecencyScore } from "../../utils/relevance";
import { parseSince } from "../../utils/temporal";
import { escapeFts5Query } from "../../utils/validation";
import type {
  DecisionsInput,
  FindByFileInput,
  HandlerResponse,
  SearchInput,
  TimelineInput,
  WorkerDeps,
} from "./types";

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

  // type === "observations" — graph-based retrieval
  if (!deps.modelManager || !deps.graphManager) {
    return {
      status: 503,
      body: { error: "Model manager or graph manager unavailable" },
    };
  }

  const searchResult = await queryGraph({
    db: deps.db,
    modelManager: deps.modelManager,
    graphManager: deps.graphManager,
    query,
    project,
    limit,
  });

  if (!searchResult.ok) {
    return {
      status: 500,
      body: { error: searchResult.error.message },
    };
  }

  // Post-filter by concept if provided
  let results = searchResult.value.observations;
  if (concept) {
    results = results.filter((o) =>
      o.concepts.some((c) => c.toLowerCase() === concept.toLowerCase()),
    );
  }

  return {
    status: 200,
    body: {
      results,
      count: results.length,
    },
  };
};

/**
 * Get a chronological timeline of recent observations and summaries.
 * Uses recency seeds -> graph spreading activation for observations.
 */
export const handleGetTimeline = async (
  deps: WorkerDeps,
  input: TimelineInput,
): Promise<HandlerResponse> => {
  const { project, limit, since } = input;

  const sinceEpoch = parseSince(since);

  // Get recent observations as seeds for graph expansion
  const obsResult = getRecentObservations(deps.db, {
    project,
    limit: limit * 2,
  });
  if (!obsResult.ok) {
    return {
      status: 500,
      body: { error: obsResult.error.message },
    };
  }

  let recentObs = obsResult.value;
  if (sinceEpoch !== null) {
    recentObs = recentObs.filter((o) => o.createdAtEpoch >= sinceEpoch);
  }

  // Use recent observations as seeds, expand through graph
  const seeds = recentObs.map((o) => ({
    observationId: o.id,
    activation: calculateRecencyScore(o.createdAtEpoch, 2),
  }));
  const candidateMap = new Map(recentObs.map((o) => [o.id, o]));
  const observations = deps.graphManager
    ? expandSeeds({
        db: deps.db,
        graphManager: deps.graphManager,
        seeds,
        candidateMap,
        limit,
      })
    : recentObs;

  // Get summaries (still project-scoped)
  const sumResult = getRecentSummaries(deps.db, { project, limit });
  if (!sumResult.ok) {
    return {
      status: 500,
      body: { error: sumResult.error.message },
    };
  }

  let summaries = sumResult.value;
  if (sinceEpoch !== null) {
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
 * Uses decision-type observations as seeds -> graph expansion -> filter to decisions.
 */
export const handleGetDecisions = async (
  deps: WorkerDeps,
  input: DecisionsInput,
): Promise<HandlerResponse> => {
  const { project, limit, since } = input;
  const sinceEpoch = parseSince(since);

  const result = getRecentObservations(deps.db, { project, limit: limit * 5 });
  if (!result.ok) {
    return { status: 500, body: { error: result.error.message } };
  }

  let candidates = result.value;
  if (sinceEpoch !== null) {
    candidates = candidates.filter((o) => o.createdAtEpoch >= sinceEpoch);
  }

  // Use decision observations as seeds, expand through graph
  const decisionCandidates = candidates.filter((o) => o.type === "decision");
  const seeds = decisionCandidates.map((o) => ({
    observationId: o.id,
    activation: calculateRecencyScore(o.createdAtEpoch, 2),
  }));
  const candidateMap = new Map(candidates.map((o) => [o.id, o]));

  const expanded = deps.graphManager
    ? expandSeeds({
        db: deps.db,
        graphManager: deps.graphManager,
        seeds,
        candidateMap,
        limit: limit * 2,
      })
    : decisionCandidates;

  // Filter to decisions only (graph may surface non-decision neighbors)
  const decisions = expanded
    .filter((o) => o.type === "decision")
    .slice(0, limit);

  return {
    status: 200,
    body: { results: decisions, count: decisions.length },
  };
};

/**
 * Find observations related to a specific file.
 * Uses FTS5 to find file-matching observations as seeds -> graph expansion via shares-file edges.
 */
export const handleFindByFile = async (
  deps: WorkerDeps,
  input: FindByFileInput,
): Promise<HandlerResponse> => {
  const { file, limit } = input;

  if (!file) {
    return { status: 400, body: { error: "file parameter is required" } };
  }

  // FTS5 to find initial candidates mentioning the file
  const escapedQuery = escapeFts5Query(file);
  const result = searchObservations(deps.db, {
    query: escapedQuery,
    limit: limit * 3,
  });
  if (!result.ok) {
    return { status: 500, body: { error: result.error.message } };
  }

  // Filter to observations that actually reference this file
  const fileMatches = result.value.filter(
    (o) =>
      o.filesRead.some((f) => f.includes(file)) ||
      o.filesModified.some((f) => f.includes(file)),
  );

  // Use file-matching observations as seeds for graph expansion
  const seeds = fileMatches.map((o) => ({
    observationId: o.id,
    activation: 1.0,
  }));
  const candidateMap = new Map(fileMatches.map((o) => [o.id, o]));

  const observations =
    deps.graphManager && fileMatches.length > 0
      ? expandSeeds({
          db: deps.db,
          graphManager: deps.graphManager,
          seeds,
          candidateMap,
          limit,
        })
      : fileMatches.slice(0, limit);

  return {
    status: 200,
    body: { results: observations, count: observations.length },
  };
};
