/**
 * Tier 1 — Pure computation edge finders.
 * Similarity, file overlap, concept overlap, session edges.
 */

import type { Observation } from "../types/domain";
import { cosineSimilarity } from "../utils/relevance";
import {
  jaccardCoefficient,
  type ObservationContext,
  type ProposedEdge,
} from "./linker-shared";

// ============================================================================
// Configuration
// ============================================================================

const SIMILARITY_THRESHOLD = 0.65;

// ============================================================================
// Edge Finders
// ============================================================================

/**
 * Finds similarity edges via cosine similarity between embeddings.
 * Returns edges for observations with cosine similarity >= threshold.
 */
export const findSimilarityEdges = (
  sourceCtx: ObservationContext,
  candidates: readonly {
    readonly id: number;
    readonly embedding: Float32Array;
  }[],
  threshold = SIMILARITY_THRESHOLD,
): readonly ProposedEdge[] => {
  if (!sourceCtx.embedding) return [];

  const edges: ProposedEdge[] = [];
  for (const candidate of candidates) {
    if (candidate.id === sourceCtx.id) continue;
    const similarity = cosineSimilarity(
      sourceCtx.embedding,
      candidate.embedding,
    );
    if (similarity >= threshold) {
      edges.push({
        sourceId: sourceCtx.id,
        targetId: candidate.id,
        relation: "similar-to",
        weight: similarity,
        direction: "bidirectional",
        explanation: null,
      });
    }
  }
  return edges;
};

/**
 * Finds file overlap edges based on shared files_modified.
 * Weight is Jaccard coefficient of the file sets.
 */
export const findFileOverlapEdges = (
  sourceCtx: ObservationContext,
  candidates: readonly Observation[],
): readonly ProposedEdge[] => {
  if (sourceCtx.filesModified.length === 0) return [];

  const edges: ProposedEdge[] = [];
  for (const candidate of candidates) {
    if (candidate.id === sourceCtx.id) continue;
    if (candidate.filesModified.length === 0) continue;

    const jaccard = jaccardCoefficient(
      sourceCtx.filesModified,
      candidate.filesModified,
    );
    if (jaccard > 0) {
      edges.push({
        sourceId: sourceCtx.id,
        targetId: candidate.id,
        relation: "shares-file",
        weight: jaccard,
        direction: "bidirectional",
        explanation: null,
      });
    }
  }
  return edges;
};

/**
 * Finds concept overlap edges based on shared concept tags.
 * Weight is Jaccard coefficient of concept sets.
 */
export const findConceptOverlapEdges = (
  sourceCtx: ObservationContext,
  candidates: readonly Observation[],
): readonly ProposedEdge[] => {
  if (sourceCtx.concepts.length === 0) return [];

  const edges: ProposedEdge[] = [];
  for (const candidate of candidates) {
    if (candidate.id === sourceCtx.id) continue;
    if (candidate.concepts.length === 0) continue;

    const jaccard = jaccardCoefficient(sourceCtx.concepts, candidate.concepts);
    if (jaccard > 0) {
      edges.push({
        sourceId: sourceCtx.id,
        targetId: candidate.id,
        relation: "shares-concept",
        weight: jaccard,
        direction: "bidirectional",
        explanation: null,
      });
    }
  }
  return edges;
};

/**
 * Finds session edges: same-session and followed-by.
 * same-session: bidirectional edge to all observations in the same session.
 * followed-by: directed edge from the immediately preceding observation.
 */
export const findSessionEdges = (
  sourceCtx: ObservationContext,
  candidates: readonly Observation[],
): readonly ProposedEdge[] => {
  const edges: ProposedEdge[] = [];

  const sameSession = candidates.filter(
    (c) => c.id !== sourceCtx.id && c.sdkSessionId === sourceCtx.sdkSessionId,
  );

  for (const candidate of sameSession) {
    edges.push({
      sourceId: sourceCtx.id,
      targetId: candidate.id,
      relation: "same-session",
      weight: 1.0,
      direction: "bidirectional",
      explanation: null,
    });

    // followed-by: if candidate has the immediately preceding prompt number
    if (candidate.promptNumber === sourceCtx.promptNumber - 1) {
      edges.push({
        sourceId: candidate.id,
        targetId: sourceCtx.id,
        relation: "followed-by",
        weight: 1.0,
        direction: "directed",
        explanation: null,
      });
    }
    // or if source immediately precedes candidate
    if (candidate.promptNumber === sourceCtx.promptNumber + 1) {
      edges.push({
        sourceId: sourceCtx.id,
        targetId: candidate.id,
        relation: "followed-by",
        weight: 1.0,
        direction: "directed",
        explanation: null,
      });
    }
  }

  return edges;
};
