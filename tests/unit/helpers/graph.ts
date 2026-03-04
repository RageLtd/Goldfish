/**
 * Shared test helpers for graph-related tests.
 */

import type { Observation } from "../../../src/types/domain";

/** Creates a normalized embedding vector of given length. */
export const makeEmbedding = (seed: number, length = 8): Float32Array => {
  const arr = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    arr[i] = Math.sin(seed * (i + 1));
  }
  // Normalize
  let norm = 0;
  for (let i = 0; i < length; i++) norm += arr[i] * arr[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < length; i++) arr[i] /= norm;
  return arr;
};

/** Creates an Observation with defaults, overriding with provided fields. */
export const makeObservation = (
  overrides: Partial<Observation> & { id: number },
): Observation => ({
  sdkSessionId: "test-sess",
  project: "test-project",
  type: "feature",
  title: "Test observation",
  subtitle: null,
  narrative: "Test narrative",
  facts: [],
  concepts: [],
  filesRead: [],
  filesModified: [],
  promptNumber: 1,
  discoveryTokens: 0,
  createdAt: new Date().toISOString(),
  createdAtEpoch: Date.now(),
  ...overrides,
});
