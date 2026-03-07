/**
 * In-memory embedding cache.
 * Loaded from DB at worker startup, updated incrementally on embed/prune.
 * Eliminates per-query DB I/O for embedding BLOBs.
 */

import type { Database } from "bun:sqlite";
import { getObservationsWithEmbeddings } from "../db/index";
import { ok, type Result } from "../types/result";

// ============================================================================
// Types
// ============================================================================

export interface EmbeddingCacheEntry {
  readonly id: number;
  readonly title: string | null;
  readonly narrative: string | null;
  readonly project: string;
  readonly type: string;
  readonly createdAtEpoch: number;
  readonly sdkSessionId: string;
  readonly embedding: Float32Array;
}

export type EmbeddingCache = Map<number, EmbeddingCacheEntry>;

// ============================================================================
// Load
// ============================================================================

/**
 * Loads all observations with embeddings into an in-memory cache.
 * Called once at worker startup.
 */
export const loadEmbeddingCache = (db: Database): Result<EmbeddingCache> => {
  const result = getObservationsWithEmbeddings(db, {});
  if (!result.ok) return result;

  const cache: EmbeddingCache = new Map();
  for (const entry of result.value) {
    cache.set(entry.id, entry);
  }
  return ok(cache);
};
