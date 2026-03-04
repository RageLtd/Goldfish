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

import type Graph from "graphology";

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

// ============================================================================
// Spreading Activation
// ============================================================================

/**
 * Runs spreading activation on the graph from seed nodes.
 *
 * Each seed starts with its similarity score as initial activation.
 * On each hop, activation propagates to neighbors weighted by edge weight
 * and decayed by hopDecay. Multiple paths to the same node accumulate.
 *
 * Returns activated nodes (excluding seeds) sorted by activation score.
 * When the graph has no edges, returns an empty array.
 */
export const spreadingActivation = (
  graph: Graph,
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
    if (!graph.hasNode(key)) continue;
    activations.set(key, seed.activation);
    hopDistances.set(key, 0);
    seedKeys.add(key);
  }

  // Spread activation hop by hop
  for (let hop = 1; hop <= cfg.maxHops; hop++) {
    const decay = cfg.hopDecay ** hop;
    // Snapshot current activations to avoid order-dependent propagation
    const currentActivations = new Map(activations);

    for (const [nodeKey, nodeActivation] of currentActivations) {
      const propagatedActivation = nodeActivation * decay;
      if (propagatedActivation < cfg.minActivation) continue;

      // Spread to all neighbors
      graph.forEachNeighbor(nodeKey, (neighborKey) => {
        // Get edge weight (check all edges between these nodes, take max)
        let maxWeight = 0;
        graph.forEachEdge(nodeKey, (_edge, attrs, source, target) => {
          const otherKey = source === nodeKey ? target : source;
          if (otherKey === neighborKey) {
            const w = (attrs.weight as number) ?? 1.0;
            if (w > maxWeight) maxWeight = w;
          }
        });

        const contribution = propagatedActivation * maxWeight;
        if (contribution < cfg.minActivation) return;

        const existing = activations.get(neighborKey) ?? 0;
        activations.set(neighborKey, existing + contribution);

        // Track minimum hop distance
        const existingHop = hopDistances.get(neighborKey);
        if (existingHop === undefined || hop < existingHop) {
          hopDistances.set(neighborKey, hop);
        }
      });
    }
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
