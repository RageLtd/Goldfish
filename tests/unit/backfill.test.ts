import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  createDatabase,
  createSession,
  getEmbeddingsByIds,
  getObservationsWithoutEmbeddings,
  runMigrations,
  storeObservation,
  updateObservationEmbedding,
} from "../../src/db/index";

describe("backfill DB functions", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
    runMigrations(db);
    createSession(db, {
      claudeSessionId: "sess-backfill",
      project: "backfill-project",
      userPrompt: "Test backfill",
    });
  });

  afterEach(() => {
    db.close();
  });

  describe("getObservationsWithoutEmbeddings", () => {
    it("returns observations lacking embeddings", () => {
      storeObservation(db, {
        claudeSessionId: "sess-backfill",
        project: "backfill-project",
        observation: {
          type: "discovery",
          title: "No embedding obs",
          subtitle: null,
          narrative: "This has no embedding",
          facts: [],
          concepts: [],
          filesRead: [],
          filesModified: [],
        },
        promptNumber: 1,
      });

      const result = getObservationsWithoutEmbeddings(db, { limit: 10 });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(1);
        expect(result.value[0].title).toBe("No embedding obs");
        expect(result.value[0].narrative).toBe("This has no embedding");
      }
    });

    it("excludes observations that already have embeddings", () => {
      storeObservation(db, {
        claudeSessionId: "sess-backfill",
        project: "backfill-project",
        observation: {
          type: "discovery",
          title: "Has embedding",
          subtitle: null,
          narrative: "Already embedded",
          facts: [],
          concepts: [],
          filesRead: [],
          filesModified: [],
        },
        promptNumber: 1,
      });

      // Set embedding on the observation
      const embedding = new Float32Array([0.1, 0.2, 0.3]);
      db.run("UPDATE observations SET embedding = ? WHERE id = 1", [
        Buffer.from(embedding.buffer),
      ]);

      const result = getObservationsWithoutEmbeddings(db, { limit: 10 });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(0);
      }
    });

    it("respects limit parameter", () => {
      for (let i = 0; i < 5; i++) {
        storeObservation(db, {
          claudeSessionId: "sess-backfill",
          project: "backfill-project",
          observation: {
            type: "discovery",
            title: `Obs ${i}`,
            subtitle: null,
            narrative: `Narrative ${i}`,
            facts: [],
            concepts: [],
            filesRead: [],
            filesModified: [],
          },
          promptNumber: 1,
        });
      }

      const result = getObservationsWithoutEmbeddings(db, { limit: 3 });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(3);
      }
    });
  });

  describe("updateObservationEmbedding", () => {
    it("stores embedding for an observation", () => {
      storeObservation(db, {
        claudeSessionId: "sess-backfill",
        project: "backfill-project",
        observation: {
          type: "discovery",
          title: "Test obs",
          subtitle: null,
          narrative: "Test narrative",
          facts: [],
          concepts: [],
          filesRead: [],
          filesModified: [],
        },
        promptNumber: 1,
      });

      const embedding = new Float32Array([0.1, 0.2, 0.3, 0.4]);
      const result = updateObservationEmbedding(db, 1, embedding);
      expect(result.ok).toBe(true);

      // Verify it was stored
      const row = db
        .query<{ embedding: Buffer | null }, [number]>(
          "SELECT embedding FROM observations WHERE id = ?",
        )
        .get(1);
      expect(row?.embedding).not.toBeNull();
    });
  });

  describe("getEmbeddingsByIds", () => {
    it("returns embeddings for observations that have them", () => {
      storeObservation(db, {
        claudeSessionId: "sess-backfill",
        project: "backfill-project",
        observation: {
          type: "discovery",
          title: "Embedded obs",
          subtitle: null,
          narrative: "Has embedding",
          facts: [],
          concepts: [],
          filesRead: [],
          filesModified: [],
        },
        promptNumber: 1,
      });

      const embedding = new Float32Array([0.5, 0.6, 0.7]);
      updateObservationEmbedding(db, 1, embedding);

      const result = getEmbeddingsByIds(db, { ids: [1] });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.size).toBe(1);
        const stored = result.value.get(1);
        expect(stored).toBeDefined();
        if (stored) {
          expect(stored.length).toBe(3);
          expect(stored[0]).toBeCloseTo(0.5, 2);
        }
      }
    });

    it("skips observations without embeddings", () => {
      storeObservation(db, {
        claudeSessionId: "sess-backfill",
        project: "backfill-project",
        observation: {
          type: "discovery",
          title: "No embedding",
          subtitle: null,
          narrative: "Missing",
          facts: [],
          concepts: [],
          filesRead: [],
          filesModified: [],
        },
        promptNumber: 1,
      });

      const result = getEmbeddingsByIds(db, { ids: [1] });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.size).toBe(0);
      }
    });

    it("returns empty map for empty ids", () => {
      const result = getEmbeddingsByIds(db, { ids: [] });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.size).toBe(0);
      }
    });
  });
});
