/**
 * Prune CLI command — removes stale, duplicate, and low-score observations.
 * Opens DB directly (same pattern as backfill command).
 *
 * Three strategies applied in sequence:
 * 1. Age-based — delete observations older than N days
 * 2. Deduplication — remove near-duplicate embeddings (cosine > threshold)
 * 3. Score-based — remove observations below minimum relevance score
 */

import type { Database } from "bun:sqlite";
import { DEFAULT_DB_PATH } from "../constants";
import {
  createDatabase,
  deleteObservationsByIds,
  getEmbeddingsByIds,
  getObservationsForPruning,
  runMigrations,
} from "../db/index";
import type { Observation } from "../types/domain";
import type { ScoringContext } from "../utils/relevance";
import {
  cosineSimilarity,
  DEFAULT_SCORING_CONFIG,
  scoreObservation,
} from "../utils/relevance";

const DB_PATH = process.env.GOLDFISH_DB || DEFAULT_DB_PATH;

const log = (msg: string) => console.log(`[prune] ${msg}`);

/**
 * Finds duplicate observation IDs by pairwise embedding cosine similarity.
 * Groups by project, keeps newer (lower index = more recent), removes older.
 */
const findDuplicateIds = (
  remaining: readonly {
    readonly id: number;
    readonly project: string;
    readonly hasEmbedding: boolean;
  }[],
  embeddings: Map<number, Float32Array>,
  threshold: number,
): number[] => {
  const byProject = new Map<string, number[]>();
  for (const c of remaining) {
    if (!embeddings.has(c.id)) continue;
    const group = byProject.get(c.project) ?? [];
    group.push(c.id);
    byProject.set(c.project, group);
  }

  const removedSet = new Set<number>();
  const dupIds: number[] = [];

  for (const [, ids] of byProject) {
    for (let i = 0; i < ids.length; i++) {
      if (removedSet.has(ids[i])) continue;
      const embA = embeddings.get(ids[i]);
      if (!embA) continue;

      for (let j = i + 1; j < ids.length; j++) {
        if (removedSet.has(ids[j])) continue;
        const embB = embeddings.get(ids[j]);
        if (!embB) continue;

        if (cosineSimilarity(embA, embB) > threshold) {
          removedSet.add(ids[j]);
          dupIds.push(ids[j]);
        }
      }
    }
  }

  return dupIds;
};

const MAX_AGE_DAYS = parseInt(
  process.env.GOLDFISH_PRUNE_MAX_AGE_DAYS || "90",
  10,
);
const DEDUP_THRESHOLD = parseFloat(
  process.env.GOLDFISH_PRUNE_DEDUP_THRESHOLD || "0.92",
);
const MIN_SCORE = parseFloat(process.env.GOLDFISH_PRUNE_MIN_SCORE || "0.2");

// ============================================================================
// Reusable prune logic
// ============================================================================

export interface PruneOptions {
  readonly maxAgeDays: number;
  readonly dedupThreshold: number;
  readonly minScore: number;
  readonly dryRun: boolean;
}

export interface PruneResult {
  readonly aged: number;
  readonly duplicates: number;
  readonly lowScore: number;
  readonly total: number;
  readonly deleted: number;
}

export const runPrune = (db: Database, options: PruneOptions): PruneResult => {
  const candidatesResult = getObservationsForPruning(db);
  if (!candidatesResult.ok) {
    log(`Error fetching observations: ${candidatesResult.error.message}`);
    return { aged: 0, duplicates: 0, lowScore: 0, total: 0, deleted: 0 };
  }

  const candidates = candidatesResult.value;
  log(`Found ${candidates.length} total observations`);

  // Phase 1: Age-based pruning
  const cutoffEpoch = Date.now() - options.maxAgeDays * 24 * 60 * 60 * 1000;
  const agedIds = candidates
    .filter((c) => c.createdAtEpoch < cutoffEpoch)
    .map((c) => c.id);

  log(
    `Phase 1 — aged (>${options.maxAgeDays} days): ${agedIds.length} candidates`,
  );

  // Phase 2: Deduplication via embedding cosine similarity
  const agedSet = new Set(agedIds);
  const remaining = candidates.filter((c) => !agedSet.has(c.id));
  const embeddedIds = remaining.filter((c) => c.hasEmbedding).map((c) => c.id);

  let dupIds: number[] = [];

  if (embeddedIds.length > 0) {
    const embResult = getEmbeddingsByIds(db, { ids: embeddedIds });
    if (embResult.ok) {
      dupIds = findDuplicateIds(
        remaining,
        embResult.value,
        options.dedupThreshold,
      );
    }
  }

  log(
    `Phase 2 — duplicates (cosine >${options.dedupThreshold}): ${dupIds.length} candidates`,
  );

  // Phase 3: Score-based pruning
  const phase2Removed = new Set([...agedIds, ...dupIds]);
  const scoreCandidates = candidates.filter((c) => !phase2Removed.has(c.id));

  const scoringContext: ScoringContext = {
    currentProject: "",
    cwdFiles: [],
    ftsRanks: new Map(),
    config: DEFAULT_SCORING_CONFIG,
  };

  const toObservation = (c: (typeof scoreCandidates)[number]): Observation => ({
    id: c.id,
    sdkSessionId: "",
    project: c.project,
    type: c.type as Observation["type"],
    title: c.title,
    subtitle: null,
    narrative: null,
    facts: [],
    concepts: [],
    filesRead: [],
    filesModified: [],
    promptNumber: 0,
    discoveryTokens: 0,
    createdAt: "",
    createdAtEpoch: c.createdAtEpoch,
  });

  const lowScoreIds = scoreCandidates
    .filter(
      (c) =>
        scoreObservation(toObservation(c), scoringContext) < options.minScore,
    )
    .map((c) => c.id);

  log(
    `Phase 3 — low-score (<${options.minScore}): ${lowScoreIds.length} candidates`,
  );

  const allIds = [...new Set([...agedIds, ...dupIds, ...lowScoreIds])];
  const total = allIds.length;

  log(
    `Total: ${agedIds.length} aged + ${dupIds.length} duplicates + ${lowScoreIds.length} low-score = ${total}`,
  );

  if (total === 0 || options.dryRun) {
    return {
      aged: agedIds.length,
      duplicates: dupIds.length,
      lowScore: lowScoreIds.length,
      total,
      deleted: 0,
    };
  }

  const deleteResult = deleteObservationsByIds(db, { ids: allIds });
  if (!deleteResult.ok) {
    log(`Error deleting observations: ${deleteResult.error.message}`);
    return {
      aged: agedIds.length,
      duplicates: dupIds.length,
      lowScore: lowScoreIds.length,
      total,
      deleted: 0,
    };
  }

  return {
    aged: agedIds.length,
    duplicates: dupIds.length,
    lowScore: lowScoreIds.length,
    total,
    deleted: deleteResult.value,
  };
};

// ============================================================================
// CLI entry point
// ============================================================================

export const main = async (): Promise<void> => {
  const args = process.argv.slice(3);
  const dryRun = !args.includes("--confirm");

  if (dryRun) {
    log("Dry run mode (use --confirm to actually delete)");
  }

  log(`Opening database: ${DB_PATH}`);
  const db = createDatabase(DB_PATH);
  runMigrations(db);

  const result = runPrune(db, {
    maxAgeDays: MAX_AGE_DAYS,
    dedupThreshold: DEDUP_THRESHOLD,
    minScore: MIN_SCORE,
    dryRun,
  });

  if (result.total === 0) {
    log("Nothing to prune");
  } else if (dryRun) {
    log("Dry run complete. Use --confirm to delete.");
  } else {
    log(`Removed ${result.deleted} observations`);
  }

  db.close();
};
