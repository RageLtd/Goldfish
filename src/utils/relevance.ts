/**
 * Relevance scoring for memory retrieval.
 * Pure functions that score observations based on multiple factors.
 */

import type { Observation } from "../types/domain";

// ============================================================================
// Types
// ============================================================================

export interface ScoringConfig {
  readonly recencyHalfLifeDays: number;
  readonly sameProjectBonus: number;
  readonly ftsWeight: number;
  readonly conceptWeight: number;
}

export const DEFAULT_SCORING_CONFIG: ScoringConfig = {
  recencyHalfLifeDays: 2,
  sameProjectBonus: 0.1,
  ftsWeight: 1.0,
  conceptWeight: 0.5,
};

export interface ScoringContext {
  readonly currentProject: string;
  readonly cwdFiles: readonly string[];
  readonly ftsRanks: Map<number, number>;
  readonly config?: ScoringConfig;
}

// ============================================================================
// Individual Scoring Functions
// ============================================================================

const LN2 = Math.LN2;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Exponential decay based on age.
 * Returns 1.0 for now, 0.5 after one half-life, approaching 0 over time.
 */
export const calculateRecencyScore = (
  epochMs: number,
  halfLifeDays: number,
): number => {
  const ageDays = (Date.now() - epochMs) / MS_PER_DAY;
  return Math.exp((-LN2 * ageDays) / halfLifeDays);
};

const TYPE_SCORES: Record<string, number> = {
  decision: 0.8,
  bugfix: 0.7,
  discovery: 0.6,
  feature: 0.5,
  refactor: 0.4,
  change: 0.3,
};

/**
 * Returns importance score based on observation type.
 */
export const calculateTypeScore = (type: string): number => {
  return TYPE_SCORES[type] ?? 0.3;
};

/**
 * Combines FTS5 rank and concept overlap into a similarity score (0-1.5).
 * Weights are configurable via ScoringConfig.
 */
export const calculateSimilarityScore = (
  normalizedFtsRank: number,
  conceptOverlap: number,
  ftsWeight = DEFAULT_SCORING_CONFIG.ftsWeight,
  conceptWeight = DEFAULT_SCORING_CONFIG.conceptWeight,
): number => {
  return normalizedFtsRank * ftsWeight + conceptOverlap * conceptWeight;
};

/**
 * Calculates proportion of observation files found in cwd file set.
 */
export const calculateFileOverlapScore = (
  obsFiles: readonly string[],
  cwdFiles: readonly string[],
): number => {
  if (obsFiles.length === 0 || cwdFiles.length === 0) return 0;

  const cwdSet = new Set(cwdFiles);
  let matches = 0;
  for (const f of obsFiles) {
    if (cwdSet.has(f)) matches++;
  }
  return matches / obsFiles.length;
};

// ============================================================================
// Combined Scoring
// ============================================================================

/**
 * Scores a single observation against the current context.
 *
 * Formula:
 *   score = recencyScore(0-1.0)
 *         + typeScore(0.3-0.8)
 *         + similarityScore(0-1.5)
 *         + fileOverlapScore(0-1.0)
 *         + currentProjectBonus(0.1)
 */
export const scoreObservation = (
  observation: Observation,
  context: ScoringContext,
): number => {
  const config = context.config ?? DEFAULT_SCORING_CONFIG;

  const recency = calculateRecencyScore(
    observation.createdAtEpoch,
    config.recencyHalfLifeDays,
  );

  const typeImportance = calculateTypeScore(observation.type);

  const ftsRank = context.ftsRanks.get(observation.id) ?? 0;
  // Concept overlap not yet wired; planned for future iteration
  const similarity = calculateSimilarityScore(
    ftsRank,
    0,
    config.ftsWeight,
    config.conceptWeight,
  );

  const allFiles = [...observation.filesRead, ...observation.filesModified];
  const fileOverlap = calculateFileOverlapScore(allFiles, context.cwdFiles);

  const projectBonus =
    observation.project === context.currentProject
      ? config.sameProjectBonus
      : 0;

  return recency + typeImportance + similarity + fileOverlap + projectBonus;
};
