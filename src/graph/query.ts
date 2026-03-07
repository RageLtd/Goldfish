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
import type { EmbeddingCacheEntry } from "../worker/embedding-cache";
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

/** Maximum seeds passed to spreading activation to bound graph traversal time. */
export const MAX_GRAPH_SEEDS = 50;

/** Additive weight for FTS keyword matches in hybrid scoring. */
export const FTS_BONUS = 0.3;

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
  readonly embeddingCache?: ReadonlyMap<number, EmbeddingCacheEntry>;
  /** FTS5 keyword hits (observation ID → normalized score 0-1) for hybrid search. */
  readonly ftsHits?: ReadonlyMap<number, number>;
}): Promise<Result<GraphQueryResult>> => {
  const { db, modelManager, graphManager, query, project, limit } = input;
  const t0 = isDev ? performance.now() : 0;

  const embeddingResult = await fromPromise(
    modelManager.computeEmbedding(query),
  );
  if (!embeddingResult.ok) return embeddingResult;

  const queryEmbedding = embeddingResult.value;
  const tEmbed = isDev ? performance.now() : 0;

  // Use in-memory cache when available; fall back to DB query
  let candidateMap: Map<number, EmbeddingCacheEntry>;
  if (input.embeddingCache) {
    candidateMap = new Map(input.embeddingCache);
  } else {
    const candidatesResult = getObservationsWithEmbeddings(db, {});
    if (!candidatesResult.ok) return candidatesResult;
    candidateMap = new Map(candidatesResult.value.map((c) => [c.id, c]));
  }

  // Build embedding map for seed finding
  const embeddingMap = new Map<number, Float32Array>();
  for (const [id, c] of candidateMap) {
    embeddingMap.set(id, c.embedding);
  }

  const allSeeds = findSeeds(
    queryEmbedding,
    embeddingMap,
    SEED_SIMILARITY_THRESHOLD,
    cosineSimilarity,
  );
  const seeds = allSeeds.slice(0, MAX_GRAPH_SEEDS);

  const tSeeds = isDev ? performance.now() : 0;
  debug(
    `[graph-query] seeds=${seeds.length}/${allSeeds.length} query="${query.slice(0, 60)}"`,
  );

  // Run spreading activation using pre-computed adjacency map
  const activated =
    graphManager.adjacency.size > 0
      ? spreadingActivation(graphManager.adjacency, seeds, {
          maxResults: limit * 2,
        })
      : [];

  const tGraph = isDev ? performance.now() : 0;
  debug(`[graph-query] activated=${activated.length} via graph traversal`);

  // Score: seed similarity + graph activation + project bonus
  const scoreMap = new Map<number, number>();

  for (const seed of seeds) {
    const c = candidateMap.get(seed.observationId);
    const bonus = project && c?.project === project ? SAME_PROJECT_BONUS : 0;
    scoreMap.set(seed.observationId, seed.activation + bonus);
  }

  for (const node of activated) {
    const existing = scoreMap.get(node.observationId) ?? 0;
    const c = candidateMap.get(node.observationId);
    const bonus = project && c?.project === project ? SAME_PROJECT_BONUS : 0;
    scoreMap.set(node.observationId, existing + node.activation + bonus);
  }

  // Merge FTS keyword hits — boosts dual-signal matches, adds FTS-only discoveries
  if (input.ftsHits && input.ftsHits.size > 0) {
    let ftsNew = 0;
    for (const [id, normalizedScore] of input.ftsHits) {
      const ftsScore = normalizedScore * FTS_BONUS;
      const existing = scoreMap.get(id);
      if (existing !== undefined) {
        scoreMap.set(id, existing + ftsScore);
      } else {
        const c = candidateMap.get(id);
        const bonus =
          project && c?.project === project ? SAME_PROJECT_BONUS : 0;
        scoreMap.set(id, ftsScore + bonus);
        ftsNew++;
      }
    }
    debug(
      `[graph-query] fts merged=${input.ftsHits.size} (${ftsNew} new, ${input.ftsHits.size - ftsNew} boosted)`,
    );
  }

  // Sort and limit
  const ranked = Array.from(scoreMap.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);

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

  if (isDev) {
    const total = performance.now() - t0;
    debug(
      `[graph-query] PERF total=${total.toFixed(1)}ms embed=${(tEmbed - t0).toFixed(1)}ms seeds=${(tSeeds - tEmbed).toFixed(1)}ms graph=${(tGraph - tSeeds).toFixed(1)}ms score=${(performance.now() - tGraph).toFixed(1)}ms candidates=${candidateMap.size}`,
    );
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
    graphManager.adjacency.size > 0
      ? spreadingActivation(graphManager.adjacency, seeds, {
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
