import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  createDatabase,
  createSession,
  runMigrations,
  storeObservation,
} from "../../src/db/index";
import { createGraphManager } from "../../src/graph/index";
import { enrichWithLLM } from "../../src/graph/linker";
import type { ModelManager } from "../../src/models/manager";

describe("graph linker", () => {
  // ==========================================================================
  // Tier 3: enrichWithLLM
  // ==========================================================================

  describe("enrichWithLLM (tier 3)", () => {
    let db: Database;

    /** Creates a mock ModelManager that returns canned responses in sequence. */
    const mockModelManager = (responses: string[]): ModelManager => {
      let callIndex = 0;
      return {
        getConfig: () => ({
          generativeModelId: "test",
          embeddingModelId: "test",
          generationUrl: "http://test",
          embeddingUrl: "http://test",
          cacheDir: "/tmp",
        }),
        generateText: async () => {
          const response = responses[callIndex] ?? "";
          callIndex++;
          return response;
        },
        computeEmbedding: async () => new Float32Array(8),
        dispose: async () => {},
      };
    };

    beforeEach(() => {
      db = createDatabase(":memory:");
      runMigrations(db);

      createSession(db, {
        claudeSessionId: "tier3-sess",
        project: "tier3-test",
        userPrompt: "Test",
      });

      // Create source observation
      storeObservation(db, {
        claudeSessionId: "tier3-sess",
        project: "tier3-test",
        observation: {
          type: "feature",
          title: "Source observation",
          subtitle: null,
          narrative: "The source observation narrative",
          facts: [],
          concepts: [],
          filesRead: [],
          filesModified: ["src/a.ts"],
        },
        promptNumber: 1,
      });

      // Create candidate observations
      storeObservation(db, {
        claudeSessionId: "tier3-sess",
        project: "tier3-test",
        observation: {
          type: "bugfix",
          title: "Candidate bugfix",
          subtitle: null,
          narrative: "Fixed a bug related to feature",
          facts: [],
          concepts: [],
          filesRead: [],
          filesModified: ["src/a.ts"],
        },
        promptNumber: 2,
      });

      storeObservation(db, {
        claudeSessionId: "tier3-sess",
        project: "tier3-test",
        observation: {
          type: "decision",
          title: "Candidate decision",
          subtitle: null,
          narrative: "Decided to use a different approach",
          facts: [],
          concepts: [],
          filesRead: [],
          filesModified: ["src/b.ts"],
        },
        promptNumber: 3,
      });
    });

    afterEach(() => {
      db.close();
    });

    it("returns empty when no candidates pass similarity threshold", async () => {
      const gm = createGraphManager();
      const mm = mockModelManager([]);

      const edges = await enrichWithLLM(db, gm, mm, {
        observationId: 1,
        candidates: [{ id: 2, similarity: 0.3 }], // Below 0.65 threshold
      });

      expect(edges).toEqual([]);
    });

    it("returns empty when candidates list is empty", async () => {
      const gm = createGraphManager();
      const mm = mockModelManager([]);

      const edges = await enrichWithLLM(db, gm, mm, {
        observationId: 1,
        candidates: [],
      });

      expect(edges).toEqual([]);
    });

    it("classifies relationships on first turn", async () => {
      const gm = createGraphManager();
      const classifyResponse = JSON.stringify({
        name: "classify_relationship",
        arguments: {
          relationships: [
            {
              source_id: 1,
              target_id: 2,
              relationship: "caused-by",
              direction: "b-to-a",
              strength: 0.8,
              explanation: "The bugfix was caused by the feature",
            },
          ],
        },
      });

      const mm = mockModelManager([classifyResponse]);

      const edges = await enrichWithLLM(db, gm, mm, {
        observationId: 1,
        candidates: [{ id: 2, similarity: 0.8 }],
      });

      expect(edges).toHaveLength(1);
      expect(edges[0].relation).toBe("caused-by");
      // b-to-a swaps source and target
      expect(edges[0].sourceId).toBe(2);
      expect(edges[0].targetId).toBe(1);
      expect(edges[0].direction).toBe("directed");
      expect(edges[0].weight).toBe(0.8);
    });

    it("handles query_graph then classify (2-turn)", async () => {
      const gm = createGraphManager();
      const queryResponse = JSON.stringify({
        name: "query_graph",
        arguments: { observation_id: 1 },
      });
      const classifyResponse = JSON.stringify({
        name: "classify_relationship",
        arguments: {
          relationships: [
            {
              source_id: 1,
              target_id: 2,
              relationship: "relates-to",
              direction: "bidirectional",
              strength: 0.7,
            },
          ],
        },
      });

      const mm = mockModelManager([queryResponse, classifyResponse]);

      const edges = await enrichWithLLM(db, gm, mm, {
        observationId: 1,
        candidates: [{ id: 2, similarity: 0.75 }],
      });

      expect(edges).toHaveLength(1);
      expect(edges[0].relation).toBe("relates-to");
      expect(edges[0].direction).toBe("bidirectional");
    });

    it("returns empty when max turns exceeded", async () => {
      const gm = createGraphManager();
      // Model keeps querying the graph and never classifies
      const queryResponse = JSON.stringify({
        name: "query_graph",
        arguments: { observation_id: 1 },
      });

      const mm = mockModelManager([
        queryResponse,
        queryResponse,
        queryResponse,
        queryResponse,
      ]);

      const edges = await enrichWithLLM(db, gm, mm, {
        observationId: 1,
        candidates: [{ id: 2, similarity: 0.8 }],
      });

      expect(edges).toEqual([]);
    });

    it("filters out low-strength relationships", async () => {
      const gm = createGraphManager();
      const classifyResponse = JSON.stringify({
        name: "classify_relationship",
        arguments: {
          relationships: [
            {
              source_id: 1,
              target_id: 2,
              relationship: "relates-to",
              direction: "bidirectional",
              strength: 0.3, // Below 0.5 threshold
            },
          ],
        },
      });

      const mm = mockModelManager([classifyResponse]);

      const edges = await enrichWithLLM(db, gm, mm, {
        observationId: 1,
        candidates: [{ id: 2, similarity: 0.8 }],
      });

      expect(edges).toEqual([]);
    });

    it("filters out 'none' relationships", async () => {
      const gm = createGraphManager();
      const classifyResponse = JSON.stringify({
        name: "classify_relationship",
        arguments: {
          relationships: [
            {
              source_id: 1,
              target_id: 2,
              relationship: "none",
              direction: "bidirectional",
              strength: 0.9,
            },
          ],
        },
      });

      const mm = mockModelManager([classifyResponse]);

      const edges = await enrichWithLLM(db, gm, mm, {
        observationId: 1,
        candidates: [{ id: 2, similarity: 0.8 }],
      });

      expect(edges).toEqual([]);
    });

    it("returns empty on model error", async () => {
      const gm = createGraphManager();
      const mm: ModelManager = {
        getConfig: () => ({
          generativeModelId: "test",
          embeddingModelId: "test",
          generationUrl: "http://test",
          embeddingUrl: "http://test",
          cacheDir: "/tmp",
        }),
        generateText: async () => {
          throw new Error("Model unavailable");
        },
        computeEmbedding: async () => new Float32Array(8),
        dispose: async () => {},
      };

      const edges = await enrichWithLLM(db, gm, mm, {
        observationId: 1,
        candidates: [{ id: 2, similarity: 0.8 }],
      });

      expect(edges).toEqual([]);
    });

    it("clamps strength to [0, 1]", async () => {
      const gm = createGraphManager();
      const classifyResponse = JSON.stringify({
        name: "classify_relationship",
        arguments: {
          relationships: [
            {
              source_id: 1,
              target_id: 2,
              relationship: "implements",
              direction: "a-to-b",
              strength: 1.5, // Above 1
            },
          ],
        },
      });

      const mm = mockModelManager([classifyResponse]);

      const edges = await enrichWithLLM(db, gm, mm, {
        observationId: 1,
        candidates: [{ id: 2, similarity: 0.8 }],
      });

      expect(edges).toHaveLength(1);
      expect(edges[0].weight).toBe(1.0);
    });
  });
});
