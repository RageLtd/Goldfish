/**
 * Tier 2 — Heuristic rule edge inference.
 * Supersedes, caused-by, implements.
 */

import type { Observation } from "../types/domain";
import { cosineSimilarity } from "../utils/relevance";
import {
  intersect,
  type ObservationContext,
  type ProposedEdge,
} from "./linker-shared";

// ============================================================================
// Configuration
// ============================================================================

const SUPERSEDES_SIMILARITY_THRESHOLD = 0.8;
const CAUSED_BY_TIME_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// ============================================================================
// Edge Inference
// ============================================================================

/**
 * Infers supersedes edges: same type (both decision), high embedding similarity,
 * overlapping files, newer timestamp.
 */
export const inferSupersedesEdges = (
  sourceCtx: ObservationContext,
  candidates: readonly Observation[],
  embeddingMap: Map<number, Float32Array>,
): readonly ProposedEdge[] => {
  if (sourceCtx.type !== "decision" || !sourceCtx.embedding) return [];

  const edges: ProposedEdge[] = [];
  for (const candidate of candidates) {
    if (candidate.id === sourceCtx.id) continue;
    if (candidate.type !== "decision") continue;
    if (candidate.createdAtEpoch >= sourceCtx.createdAtEpoch) continue; // source must be newer

    const candidateEmb = embeddingMap.get(candidate.id);
    if (!candidateEmb) continue;

    const similarity = cosineSimilarity(sourceCtx.embedding, candidateEmb);
    if (similarity < SUPERSEDES_SIMILARITY_THRESHOLD) continue;

    const fileOverlap = intersect(
      sourceCtx.filesModified,
      candidate.filesModified,
    );
    if (fileOverlap.length === 0) continue;

    // Confidence based on how many signals match
    const weight = Math.min(1.0, similarity * 0.5 + fileOverlap.length * 0.25);
    edges.push({
      sourceId: sourceCtx.id,
      targetId: candidate.id,
      relation: "supersedes",
      weight,
      direction: "directed",
      explanation: null,
    });
  }
  return edges;
};

/**
 * Infers caused-by edges: source is change/refactor, target is bugfix,
 * shared files, target is newer within configurable time window.
 */
export const inferCausedByEdges = (
  sourceCtx: ObservationContext,
  candidates: readonly Observation[],
  timeWindowMs = CAUSED_BY_TIME_WINDOW_MS,
): readonly ProposedEdge[] => {
  const edges: ProposedEdge[] = [];

  // Case 1: source is bugfix — look for preceding changes that caused it
  if (sourceCtx.type === "bugfix") {
    for (const candidate of candidates) {
      if (candidate.id === sourceCtx.id) continue;
      if (candidate.type !== "change" && candidate.type !== "refactor")
        continue;
      if (candidate.createdAtEpoch >= sourceCtx.createdAtEpoch) continue;
      if (sourceCtx.createdAtEpoch - candidate.createdAtEpoch > timeWindowMs)
        continue;

      const fileOverlap = intersect(
        sourceCtx.filesModified,
        candidate.filesModified,
      );
      if (fileOverlap.length === 0) continue;

      const weight = Math.min(1.0, 0.5 + fileOverlap.length * 0.2);
      edges.push({
        sourceId: sourceCtx.id,
        targetId: candidate.id,
        relation: "caused-by",
        weight,
        direction: "directed",
        explanation: null,
      });
    }
  }

  // Case 2: source is change/refactor — look for subsequent bugfixes it may have caused
  if (sourceCtx.type === "change" || sourceCtx.type === "refactor") {
    for (const candidate of candidates) {
      if (candidate.id === sourceCtx.id) continue;
      if (candidate.type !== "bugfix") continue;
      if (candidate.createdAtEpoch <= sourceCtx.createdAtEpoch) continue;
      if (candidate.createdAtEpoch - sourceCtx.createdAtEpoch > timeWindowMs)
        continue;

      const fileOverlap = intersect(
        sourceCtx.filesModified,
        candidate.filesModified,
      );
      if (fileOverlap.length === 0) continue;

      const weight = Math.min(1.0, 0.5 + fileOverlap.length * 0.2);
      edges.push({
        sourceId: candidate.id,
        targetId: sourceCtx.id,
        relation: "caused-by",
        weight,
        direction: "directed",
        explanation: null,
      });
    }
  }

  return edges;
};

/**
 * Infers implements edges: source is decision, target is feature,
 * overlapping files/concepts, target is newer.
 */
export const inferImplementsEdges = (
  sourceCtx: ObservationContext,
  candidates: readonly Observation[],
): readonly ProposedEdge[] => {
  const edges: ProposedEdge[] = [];

  // Case 1: source is decision — look for features implementing it
  if (sourceCtx.type === "decision") {
    for (const candidate of candidates) {
      if (candidate.id === sourceCtx.id) continue;
      if (candidate.type !== "feature") continue;
      if (candidate.createdAtEpoch <= sourceCtx.createdAtEpoch) continue;

      const fileOverlap = intersect(
        sourceCtx.filesModified,
        candidate.filesModified,
      );
      const conceptOverlap = intersect(sourceCtx.concepts, candidate.concepts);
      if (fileOverlap.length === 0 && conceptOverlap.length === 0) continue;

      const weight = Math.min(
        1.0,
        0.4 + fileOverlap.length * 0.2 + conceptOverlap.length * 0.15,
      );
      edges.push({
        sourceId: candidate.id,
        targetId: sourceCtx.id,
        relation: "implements",
        weight,
        direction: "directed",
        explanation: null,
      });
    }
  }

  // Case 2: source is feature — look for decisions it implements
  if (sourceCtx.type === "feature") {
    for (const candidate of candidates) {
      if (candidate.id === sourceCtx.id) continue;
      if (candidate.type !== "decision") continue;
      if (candidate.createdAtEpoch >= sourceCtx.createdAtEpoch) continue;

      const fileOverlap = intersect(
        sourceCtx.filesModified,
        candidate.filesModified,
      );
      const conceptOverlap = intersect(sourceCtx.concepts, candidate.concepts);
      if (fileOverlap.length === 0 && conceptOverlap.length === 0) continue;

      const weight = Math.min(
        1.0,
        0.4 + fileOverlap.length * 0.2 + conceptOverlap.length * 0.15,
      );
      edges.push({
        sourceId: sourceCtx.id,
        targetId: candidate.id,
        relation: "implements",
        weight,
        direction: "directed",
        explanation: null,
      });
    }
  }

  return edges;
};
