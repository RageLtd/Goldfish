import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  createDatabase,
  createSession,
  runMigrations,
  storeEdge,
  storeObservation,
  updateObservationEmbedding,
} from "../../src/db/index";
import {
  createGraphManager,
  type GraphManager,
  queryGraph,
} from "../../src/graph/index";
import type { ModelManager } from "../../src/models/manager";
import { makeEmbedding } from "./helpers/graph";

// ============================================================================
// Integration tests: queryGraph
// ============================================================================

describe("graph retrieval", () => {
  describe("queryGraph", () => {
    let db: Database;
    let gm: GraphManager;

    const mockModelManager = (
      embedding: Float32Array = makeEmbedding(1),
    ): ModelManager => ({
      getConfig: () => ({
        generativeModelId: "test",
        embeddingModelId: "test",
        generationUrl: "http://test",
        embeddingUrl: "http://test",
        cacheDir: "/tmp",
      }),
      generateText: async () => "",
      computeEmbedding: async () => embedding,
      dispose: async () => {},
    });

    beforeEach(() => {
      db = createDatabase(":memory:");
      runMigrations(db);
      gm = createGraphManager();

      createSession(db, {
        claudeSessionId: "query-sess",
        project: "query-test",
        userPrompt: "Test",
      });
    });

    afterEach(() => {
      db.close();
    });

    it("returns empty when no observations exist", async () => {
      const mm = mockModelManager();
      const result = await queryGraph({
        db,
        modelManager: mm,
        graphManager: gm,
        query: "test query",
        limit: 10,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.observations).toEqual([]);
      }
    });

    it("returns observations matching query embedding", async () => {
      const emb = makeEmbedding(1);
      const obs = storeObservation(db, {
        claudeSessionId: "query-sess",
        project: "query-test",
        observation: {
          type: "feature",
          title: "Matching observation",
          subtitle: null,
          narrative: "Should match query",
          facts: [],
          concepts: [],
          filesRead: [],
          filesModified: [],
        },
        promptNumber: 1,
      });

      if (!obs.ok) throw new Error("Setup failed");
      updateObservationEmbedding(db, obs.value, emb);

      // Mock returns same embedding as stored — perfect match
      const mm = mockModelManager(emb);
      const result = await queryGraph({
        db,
        modelManager: mm,
        graphManager: gm,
        query: "matching query",
        limit: 10,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.observations).toHaveLength(1);
        expect(result.value.observations[0].title).toBe("Matching observation");
      }
    });

    it("applies same-project bonus", async () => {
      const emb1 = makeEmbedding(1);
      const emb2 = makeEmbedding(1.01); // very similar

      // Same project
      const obs1 = storeObservation(db, {
        claudeSessionId: "query-sess",
        project: "query-test",
        observation: {
          type: "feature",
          title: "Same project",
          subtitle: null,
          narrative: "Same project observation",
          facts: [],
          concepts: [],
          filesRead: [],
          filesModified: [],
        },
        promptNumber: 1,
      });

      // Create a second session for different project
      createSession(db, {
        claudeSessionId: "query-sess-2",
        project: "other-project",
        userPrompt: "Test",
      });

      const obs2 = storeObservation(db, {
        claudeSessionId: "query-sess-2",
        project: "other-project",
        observation: {
          type: "feature",
          title: "Other project",
          subtitle: null,
          narrative: "Different project observation",
          facts: [],
          concepts: [],
          filesRead: [],
          filesModified: [],
        },
        promptNumber: 1,
      });

      if (!obs1.ok || !obs2.ok) throw new Error("Setup failed");
      updateObservationEmbedding(db, obs1.value, emb1);
      updateObservationEmbedding(db, obs2.value, emb2);

      const mm = mockModelManager(emb1);
      const result = await queryGraph({
        db,
        modelManager: mm,
        graphManager: gm,
        query: "test",
        project: "query-test",
        limit: 10,
      });

      expect(result.ok).toBe(true);
      if (result.ok && result.value.observations.length >= 2) {
        // Same-project observation should rank first
        expect(result.value.observations[0].project).toBe("query-test");
      }
    });

    it("discovers observations via graph traversal", async () => {
      const seedEmb = makeEmbedding(1);
      const distantEmb = makeEmbedding(50); // very different embedding

      const obs1 = storeObservation(db, {
        claudeSessionId: "query-sess",
        project: "query-test",
        observation: {
          type: "feature",
          title: "Seed",
          subtitle: null,
          narrative: "Direct match",
          facts: [],
          concepts: [],
          filesRead: [],
          filesModified: [],
        },
        promptNumber: 1,
      });

      const obs2 = storeObservation(db, {
        claudeSessionId: "query-sess",
        project: "query-test",
        observation: {
          type: "bugfix",
          title: "Graph neighbor",
          subtitle: null,
          narrative: "Found via graph not embedding",
          facts: [],
          concepts: [],
          filesRead: [],
          filesModified: [],
        },
        promptNumber: 2,
      });

      if (!obs1.ok || !obs2.ok) throw new Error("Setup failed");
      updateObservationEmbedding(db, obs1.value, seedEmb);
      updateObservationEmbedding(db, obs2.value, distantEmb);

      // Link them in graph
      storeEdge(db, {
        sourceId: obs1.value,
        targetId: obs2.value,
        relation: "caused-by",
        weight: 0.9,
        direction: "directed",
      });
      gm.hydrate(db);

      const mm = mockModelManager(seedEmb);
      const result = await queryGraph({
        db,
        modelManager: mm,
        graphManager: gm,
        query: "test",
        limit: 10,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        const ids = result.value.observations.map((o) => o.id);
        expect(ids).toContain(obs1.value); // seed
        expect(ids).toContain(obs2.value); // graph-discovered
      }
    });

    it("respects limit", async () => {
      const emb = makeEmbedding(1);

      for (let i = 0; i < 5; i++) {
        const obs = storeObservation(db, {
          claudeSessionId: "query-sess",
          project: "query-test",
          observation: {
            type: "feature",
            title: `Obs ${i}`,
            subtitle: null,
            narrative: `Observation ${i}`,
            facts: [],
            concepts: [],
            filesRead: [],
            filesModified: [],
          },
          promptNumber: i + 1,
        });
        if (!obs.ok) throw new Error("Setup failed");
        // Slightly vary embeddings so all are seeds
        updateObservationEmbedding(db, obs.value, makeEmbedding(1 + i * 0.01));
      }

      const mm = mockModelManager(emb);
      const result = await queryGraph({
        db,
        modelManager: mm,
        graphManager: gm,
        query: "test",
        limit: 2,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.observations.length).toBeLessThanOrEqual(2);
      }
    });

    it("returns error when embedding computation fails", async () => {
      const mm: ModelManager = {
        getConfig: () => ({
          generativeModelId: "test",
          embeddingModelId: "test",
          generationUrl: "http://test",
          embeddingUrl: "http://test",
          cacheDir: "/tmp",
        }),
        generateText: async () => "",
        computeEmbedding: async () => {
          throw new Error("Embedding model unavailable");
        },
        dispose: async () => {},
      };

      const result = await queryGraph({
        db,
        modelManager: mm,
        graphManager: gm,
        query: "test",
        limit: 10,
      });

      expect(result.ok).toBe(false);
    });
  });
});
