/**
 * Graph-based retrieval using spreading activation.
 * Replaces flat scoring with graph traversal for memory retrieval.
 *
 * Algorithm:
 * 1. Seed nodes get initial activation from similarity scores
 * 2. Activation spreads through graph edges, decaying per hop
 * 3. Multiple paths to the same node accumulate additively
 * 4. Returns top-N activated nodes sorted by final activation
 */

// ============================================================================
// Types
// ============================================================================

export interface ScoredSeed {
  readonly observationId: number;
  readonly activation: number;
}

export interface ActivatedNode {
  readonly observationId: number;
  readonly activation: number;
  readonly hopsFromSeed: number;
}

export interface ActivationConfig {
  readonly maxHops: number;
  readonly hopDecay: number;
  readonly minActivation: number;
  readonly maxResults: number;
}

export const DEFAULT_ACTIVATION_CONFIG: ActivationConfig = {
  maxHops: 3,
  hopDecay: 0.5,
  minActivation: 0.05,
  maxResults: 20,
};

/** Pre-computed neighbor entry for fast adjacency lookups. */
export interface AdjacencyEntry {
  readonly neighbor: string;
  readonly weight: number;
}

/** Pre-computed adjacency map: node key → neighbor entries (max weight per neighbor). */
export type AdjacencyMap = ReadonlyMap<string, readonly AdjacencyEntry[]>;

// ============================================================================
// Spreading Activation
// ============================================================================

/**
 * Runs frontier-based spreading activation using a pre-computed adjacency map.
 *
 * Each seed starts with its similarity score as initial activation.
 * On each hop, only nodes in the frontier (activated in the previous hop)
 * propagate to neighbors, weighted by edge weight and decayed by hopDecay.
 * Multiple paths to the same node accumulate.
 *
 * Returns activated nodes (excluding seeds) sorted by activation score.
 */
export const spreadingActivation = (
  adjacency: AdjacencyMap,
  seeds: readonly ScoredSeed[],
  config?: Partial<ActivationConfig>,
): readonly ActivatedNode[] => {
  const cfg = { ...DEFAULT_ACTIVATION_CONFIG, ...config };

  if (seeds.length === 0) return [];

  // Track activation per node and minimum hop distance
  const activations = new Map<string, number>();
  const hopDistances = new Map<string, number>();
  const seedKeys = new Set<string>();

  // Initialize seeds
  for (const seed of seeds) {
    const key = String(seed.observationId);
    if (!adjacency.has(key)) continue;
    activations.set(key, seed.activation);
    hopDistances.set(key, 0);
    seedKeys.add(key);
  }

  // Frontier-based spreading: only propagate from nodes activated last hop
  let frontier = new Set<string>(seedKeys);

  for (let hop = 1; hop <= cfg.maxHops; hop++) {
    const decay = cfg.hopDecay ** hop;
    const deltas = new Map<string, number>();
    const nextFrontier = new Set<string>();

    for (const nodeKey of frontier) {
      const nodeActivation = activations.get(nodeKey) ?? 0;
      const propagated = nodeActivation * decay;
      if (propagated < cfg.minActivation) continue;

      const neighbors = adjacency.get(nodeKey);
      if (!neighbors) continue;

      for (const { neighbor, weight } of neighbors) {
        const contribution = propagated * weight;
        if (contribution < cfg.minActivation) continue;
        deltas.set(neighbor, (deltas.get(neighbor) ?? 0) + contribution);
        nextFrontier.add(neighbor);
      }
    }

    // Apply all deltas after the full hop
    for (const [key, delta] of deltas) {
      activations.set(key, (activations.get(key) ?? 0) + delta);

      const existingHop = hopDistances.get(key);
      if (existingHop === undefined || hop < existingHop) {
        hopDistances.set(key, hop);
      }
    }

    frontier = nextFrontier;
  }

  // Collect results (exclude seed nodes)
  const results: ActivatedNode[] = [];
  for (const [key, activation] of activations) {
    if (seedKeys.has(key)) continue;
    if (activation < cfg.minActivation) continue;

    results.push({
      observationId: Number(key),
      activation,
      hopsFromSeed: hopDistances.get(key) ?? 0,
    });
  }

  // Sort by activation descending, limit to maxResults
  results.sort((a, b) => b.activation - a.activation);
  return results.slice(0, cfg.maxResults);
};

/**
 * Finds seed nodes by computing cosine similarity between a query embedding
 * and all stored embeddings. Returns observations above the threshold
 * with their similarity as initial activation.
 */
export const findSeeds = (
  queryEmbedding: Float32Array,
  storedEmbeddings: ReadonlyMap<number, Float32Array>,
  threshold: number,
  cosineFn: (a: Float32Array, b: Float32Array) => number,
): readonly ScoredSeed[] => {
  const seeds: ScoredSeed[] = [];
  for (const [id, embedding] of storedEmbeddings) {
    const similarity = cosineFn(queryEmbedding, embedding);
    if (similarity >= threshold) {
      seeds.push({ observationId: id, activation: similarity });
    }
  }
  // Sort by activation descending
  seeds.sort((a, b) => b.activation - a.activation);
  return seeds;
};
