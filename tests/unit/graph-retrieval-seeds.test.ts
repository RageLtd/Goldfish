import { describe, expect, it } from "bun:test";
import {
  createGraphManager,
  SAME_PROJECT_BONUS,
  SEED_SIMILARITY_THRESHOLD,
} from "../../src/graph/index";
import {
  DEFAULT_ACTIVATION_CONFIG,
  findSeeds,
  type ScoredSeed,
  spreadingActivation,
} from "../../src/graph/retrieval";
import { makeEmbedding } from "./helpers/graph";

// ============================================================================
// Test helpers
// ============================================================================

/** Simple cosine similarity for tests. */
const cosine = (a: Float32Array, b: Float32Array): number => {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
};

// ============================================================================
// Unit tests: findSeeds
// ============================================================================

describe("graph retrieval", () => {
  describe("findSeeds", () => {
    it("returns empty for no stored embeddings", () => {
      const query = makeEmbedding(1);
      const stored = new Map<number, Float32Array>();

      expect(findSeeds(query, stored, 0.4, cosine)).toEqual([]);
    });

    it("returns seeds above threshold", () => {
      const query = makeEmbedding(1);
      const stored = new Map<number, Float32Array>();
      stored.set(1, makeEmbedding(1)); // identical = cosine 1.0
      stored.set(2, makeEmbedding(100)); // very different

      const seeds = findSeeds(query, stored, 0.9, cosine);

      expect(seeds.length).toBeGreaterThanOrEqual(1);
      expect(seeds[0].observationId).toBe(1);
      expect(seeds[0].activation).toBeCloseTo(1.0, 2);
    });

    it("returns seeds sorted by activation descending", () => {
      const query = makeEmbedding(1);
      const stored = new Map<number, Float32Array>();
      stored.set(1, makeEmbedding(1)); // best match
      stored.set(2, makeEmbedding(1.05)); // close match
      stored.set(3, makeEmbedding(1.1)); // less close

      const seeds = findSeeds(query, stored, 0.1, cosine);

      for (let i = 1; i < seeds.length; i++) {
        expect(seeds[i - 1].activation).toBeGreaterThanOrEqual(
          seeds[i].activation,
        );
      }
    });

    it("excludes seeds below threshold", () => {
      const query = makeEmbedding(1);
      const stored = new Map<number, Float32Array>();
      stored.set(1, makeEmbedding(50)); // likely below high threshold

      const seeds = findSeeds(query, stored, 0.999, cosine);
      expect(seeds).toEqual([]);
    });
  });

  // ==========================================================================
  // Unit tests: spreadingActivation
  // ==========================================================================

  describe("spreadingActivation", () => {
    it("returns empty for empty seeds", () => {
      const gm = createGraphManager();
      expect(spreadingActivation(gm.adjacency, [])).toEqual([]);
    });

    it("returns empty when seeds have no graph connections", () => {
      const gm = createGraphManager();
      // Add isolated node
      gm.graph.addNode("1", { id: 1 });

      const seeds: ScoredSeed[] = [{ observationId: 1, activation: 0.8 }];
      const result = spreadingActivation(gm.adjacency, seeds);

      expect(result).toEqual([]);
    });

    it("propagates activation to direct neighbors", () => {
      const gm = createGraphManager();
      gm.addEdge({
        id: 1,
        sourceId: 1,
        targetId: 2,
        relation: "similar-to",
        weight: 0.9,
        direction: "bidirectional",
        explanation: null,
        metadata: null,
        createdAtEpoch: Date.now(),
      });

      const seeds: ScoredSeed[] = [{ observationId: 1, activation: 0.8 }];
      const result = spreadingActivation(gm.adjacency, seeds);

      expect(result).toHaveLength(1);
      expect(result[0].observationId).toBe(2);
      expect(result[0].activation).toBeGreaterThan(0);
      expect(result[0].hopsFromSeed).toBe(1);
    });

    it("propagates through multiple hops with decay", () => {
      const gm = createGraphManager();
      // Chain: 1 → 2 → 3
      gm.addEdge({
        id: 1,
        sourceId: 1,
        targetId: 2,
        relation: "similar-to",
        weight: 1.0,
        direction: "bidirectional",
        explanation: null,
        metadata: null,
        createdAtEpoch: Date.now(),
      });
      gm.addEdge({
        id: 2,
        sourceId: 2,
        targetId: 3,
        relation: "similar-to",
        weight: 1.0,
        direction: "bidirectional",
        explanation: null,
        metadata: null,
        createdAtEpoch: Date.now(),
      });

      const seeds: ScoredSeed[] = [{ observationId: 1, activation: 1.0 }];
      const result = spreadingActivation(gm.adjacency, seeds, { maxHops: 3 });

      expect(result.length).toBeGreaterThanOrEqual(2);
      const node2 = result.find((n) => n.observationId === 2);
      const node3 = result.find((n) => n.observationId === 3);

      expect(node2).toBeDefined();
      expect(node3).toBeDefined();
      // Node 2 should have higher activation than node 3 (closer to seed)
      expect(node2!.activation).toBeGreaterThan(node3!.activation);
      expect(node2!.hopsFromSeed).toBe(1);
      expect(node3!.hopsFromSeed).toBe(2);
    });

    it("accumulates activation from multiple paths", () => {
      const gm = createGraphManager();
      // Two seeds both connect to node 3
      gm.addEdge({
        id: 1,
        sourceId: 1,
        targetId: 3,
        relation: "similar-to",
        weight: 1.0,
        direction: "bidirectional",
        explanation: null,
        metadata: null,
        createdAtEpoch: Date.now(),
      });
      gm.addEdge({
        id: 2,
        sourceId: 2,
        targetId: 3,
        relation: "shares-file",
        weight: 1.0,
        direction: "bidirectional",
        explanation: null,
        metadata: null,
        createdAtEpoch: Date.now(),
      });

      const seeds: ScoredSeed[] = [
        { observationId: 1, activation: 0.5 },
        { observationId: 2, activation: 0.5 },
      ];
      const result = spreadingActivation(gm.adjacency, seeds);

      const node3 = result.find((n) => n.observationId === 3);
      expect(node3).toBeDefined();
      // Should accumulate from both seeds
      expect(node3!.activation).toBeGreaterThan(0.2);
    });

    it("excludes seeds from results", () => {
      const gm = createGraphManager();
      gm.addEdge({
        id: 1,
        sourceId: 1,
        targetId: 2,
        relation: "similar-to",
        weight: 1.0,
        direction: "bidirectional",
        explanation: null,
        metadata: null,
        createdAtEpoch: Date.now(),
      });

      const seeds: ScoredSeed[] = [{ observationId: 1, activation: 0.8 }];
      const result = spreadingActivation(gm.adjacency, seeds);

      expect(result.every((n) => n.observationId !== 1)).toBe(true);
    });

    it("respects maxResults", () => {
      const gm = createGraphManager();
      // Create a hub: 1 connected to 2,3,4,5
      for (let i = 2; i <= 5; i++) {
        gm.addEdge({
          id: i,
          sourceId: 1,
          targetId: i,
          relation: "similar-to",
          weight: 1.0,
          direction: "bidirectional",
          explanation: null,
          metadata: null,
          createdAtEpoch: Date.now(),
        });
      }

      const seeds: ScoredSeed[] = [{ observationId: 1, activation: 1.0 }];
      const result = spreadingActivation(gm.adjacency, seeds, {
        maxResults: 2,
      });

      expect(result).toHaveLength(2);
    });

    it("stops propagation below minActivation", () => {
      const gm = createGraphManager();
      // Long chain: 1 → 2 → 3 → 4 → 5
      for (let i = 1; i < 5; i++) {
        gm.addEdge({
          id: i,
          sourceId: i,
          targetId: i + 1,
          relation: "similar-to",
          weight: 0.3,
          direction: "bidirectional",
          explanation: null,
          metadata: null,
          createdAtEpoch: Date.now(),
        });
      }

      const seeds: ScoredSeed[] = [{ observationId: 1, activation: 0.5 }];
      const result = spreadingActivation(gm.adjacency, seeds, {
        minActivation: 0.05,
        maxHops: 4,
      });

      // With weight 0.3, hopDecay 0.5, activation drops fast
      // Hop 1: 0.5 * 0.5 * 0.3 = 0.075
      // Hop 2: 0.075 * 0.25 * 0.3 = 0.005625 < 0.05 → cut off
      expect(
        result.every(
          (n) => n.activation >= DEFAULT_ACTIVATION_CONFIG.minActivation,
        ),
      ).toBe(true);
    });

    it("handles seed not in graph gracefully", () => {
      const gm = createGraphManager();
      const seeds: ScoredSeed[] = [{ observationId: 999, activation: 0.8 }];
      const result = spreadingActivation(gm.adjacency, seeds);

      expect(result).toEqual([]);
    });
  });

  // ==========================================================================
  // Constants
  // ==========================================================================

  describe("constants", () => {
    it("exports expected defaults", () => {
      expect(SAME_PROJECT_BONUS).toBe(0.15);
      expect(SEED_SIMILARITY_THRESHOLD).toBe(0.4);
      expect(DEFAULT_ACTIVATION_CONFIG.maxHops).toBe(3);
      expect(DEFAULT_ACTIVATION_CONFIG.hopDecay).toBe(0.5);
      expect(DEFAULT_ACTIVATION_CONFIG.minActivation).toBe(0.05);
      expect(DEFAULT_ACTIVATION_CONFIG.maxResults).toBe(20);
    });
  });
});
