/**
 * Shared types and helpers for the linker pipeline.
 * Used by linker.ts, linker-tier1.ts, and linker-tier2.ts.
 */

import type { EdgeDirection, EdgeRelationType } from "../types/domain";

// ============================================================================
// Types
// ============================================================================

export interface ProposedEdge {
  readonly sourceId: number;
  readonly targetId: number;
  readonly relation: EdgeRelationType;
  readonly weight: number;
  readonly direction: EdgeDirection;
  readonly explanation: string | null;
}

export interface ObservationContext {
  readonly id: number;
  readonly type: string;
  readonly sdkSessionId: string;
  readonly project: string;
  readonly filesModified: readonly string[];
  readonly filesRead: readonly string[];
  readonly concepts: readonly string[];
  readonly promptNumber: number;
  readonly createdAtEpoch: number;
  readonly embedding: Float32Array | null;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Computes Jaccard coefficient between two string sets.
 */
export const jaccardCoefficient = (
  a: readonly string[],
  b: readonly string[],
): number => {
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
};

/**
 * Returns the intersection of two string arrays.
 */
export const intersect = (
  a: readonly string[],
  b: readonly string[],
): readonly string[] => {
  const setB = new Set(b);
  return a.filter((item) => setB.has(item));
};
