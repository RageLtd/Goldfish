/**
 * High-level graph retrieval orchestration.
 *
 * Combines DB lookups, embedding computation, and spreading activation
 * into reusable retrieval functions. Handlers call these instead of
 * reimplementing the seed → graph → fetch pattern.
 */

import type { Database } from "bun:sqlite";
import { getObservationById, getObservationsWithEmbeddings } from "../db/index";
import type { ModelManager } from "../models/manager";
import type { Observation } from "../types/domain";
import { fromPromise, ok, type Result } from "../types/result";
import { cosineSimilarity } from "../utils/relevance";
import type { GraphManager } from "./manager";
import { findSeeds, type ScoredSeed, spreadingActivation } from "./retrieval";

const isDev = process.env.NODE_ENV === "development";
const debug = isDev ? (...args: unknown[]) => console.debug(...args) : () => {};

// ============================================================================
// Constants
// ============================================================================

/** Additive bonus for same-project observations during scoring. */
export const SAME_PROJECT_BONUS = 0.15;

/** Minimum cosine similarity for an observation to be considered a seed. */
export const SEED_SIMILARITY_THRESHOLD = 0.4;

// ============================================================================
// Types
// ============================================================================

export interface GraphQueryResult {
  readonly observations: readonly Observation[];
}

// ============================================================================
// Query-based retrieval (embedding → seeds → graph → observations)
// ============================================================================

/**
 * Query-based graph retrieval.
 * 1. Computes query embedding
 * 2. Finds seed nodes via cosine similarity against all stored embeddings
 * 3. Runs spreading activation through the knowledge graph
 * 4. Merges seeds + graph-discovered nodes, scored with project bonus
 * 5. Returns ranked observations
 *
 * When the graph has no edges, returns seeds only (embedding similarity).
 */
export const queryGraph = async (input: {
  readonly db: Database;
  readonly modelManager: ModelManager;
  readonly graphManager: GraphManager;
  readonly query: string;
  readonly project?: string;
  readonly limit: number;
}): Promise<Result<GraphQueryResult>> => {
  const { db, modelManager, graphManager, query, project, limit } = input;

  const embeddingResult = await fromPromise(
    modelManager.computeEmbedding(query),
  );
  if (!embeddingResult.ok) return embeddingResult;

  const queryEmbedding = embeddingResult.value;
  const candidatesResult = getObservationsWithEmbeddings(db, {});
  if (!candidatesResult.ok) return candidatesResult;

  const candidates = candidatesResult.value;

  // Build embedding map for seed finding
  const embeddingMap = new Map<number, Float32Array>();
  for (const c of candidates) {
    embeddingMap.set(c.id, c.embedding);
  }

  const seeds = findSeeds(
    queryEmbedding,
    embeddingMap,
    SEED_SIMILARITY_THRESHOLD,
    cosineSimilarity,
  );

  debug(`[graph-query] seeds=${seeds.length} query="${query.slice(0, 60)}"`);

  // Run spreading activation
  const activated =
    graphManager.graph.size > 0
      ? spreadingActivation(graphManager.graph, seeds, {
          maxResults: limit * 2,
        })
      : [];

  debug(`[graph-query] activated=${activated.length} via graph traversal`);

  // Score: seed similarity + graph activation + project bonus
  const scoreMap = new Map<number, number>();

  for (const seed of seeds) {
    const c = candidates.find((x) => x.id === seed.observationId);
    const bonus = project && c?.project === project ? SAME_PROJECT_BONUS : 0;
    scoreMap.set(seed.observationId, seed.activation + bonus);
  }

  for (const node of activated) {
    const existing = scoreMap.get(node.observationId) ?? 0;
    const c = candidates.find((x) => x.id === node.observationId);
    const bonus = project && c?.project === project ? SAME_PROJECT_BONUS : 0;
    scoreMap.set(node.observationId, existing + node.activation + bonus);
  }

  // Sort and limit
  const ranked = Array.from(scoreMap.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);

  // Build candidate lookup for fast access
  const candidateMap = new Map(candidates.map((c) => [c.id, c]));

  const observations: Observation[] = [];
  for (const [id] of ranked) {
    const c = candidateMap.get(id);
    if (c) {
      observations.push({
        id: c.id,
        sdkSessionId: c.sdkSessionId,
        project: c.project,
        type: c.type as Observation["type"],
        title: c.title,
        subtitle: null,
        narrative: c.narrative,
        facts: [],
        concepts: [],
        filesRead: [],
        filesModified: [],
        promptNumber: 0,
        discoveryTokens: 0,
        createdAt: "",
        createdAtEpoch: c.createdAtEpoch,
      });
    } else {
      const obsResult = getObservationById(db, id);
      if (obsResult.ok && obsResult.value) {
        observations.push(obsResult.value);
      }
    }
  }

  return ok({ observations });
};

// ============================================================================
// Seed-based expansion (pre-computed seeds → graph → observations)
// ============================================================================

/**
 * Expands pre-computed seeds through the graph and fetches observations.
 * Used when callers already have seed observations (recency, file match, etc.)
 * rather than a text query.
 *
 * @param candidateMap - pre-fetched observations to avoid redundant DB lookups
 */
export const expandSeeds = (input: {
  readonly db: Database;
  readonly graphManager: GraphManager;
  readonly seeds: readonly ScoredSeed[];
  readonly candidateMap: ReadonlyMap<number, Observation>;
  readonly limit: number;
}): readonly Observation[] => {
  const { db, graphManager, seeds, candidateMap, limit } = input;

  const activated =
    graphManager.graph.size > 0
      ? spreadingActivation(graphManager.graph, seeds, {
          maxResults: limit * 2,
        })
      : [];

  // Merge seed IDs + activated IDs, deduped, preserving order
  const idSet = new Set<number>();
  const merged: number[] = [];
  for (const s of seeds) {
    if (!idSet.has(s.observationId)) {
      idSet.add(s.observationId);
      merged.push(s.observationId);
    }
  }
  for (const a of activated) {
    if (!idSet.has(a.observationId)) {
      idSet.add(a.observationId);
      merged.push(a.observationId);
    }
  }

  // Fetch observations, using candidateMap as cache
  const result: Observation[] = [];
  for (const id of merged.slice(0, limit)) {
    const cached = candidateMap.get(id);
    if (cached) {
      result.push(cached);
    } else {
      const obsResult = getObservationById(db, id);
      if (obsResult.ok && obsResult.value) {
        result.push(obsResult.value);
      }
    }
  }
  return result;
};
