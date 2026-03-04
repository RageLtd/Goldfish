import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  createDatabase,
  createSession,
  getAllEdges,
  runMigrations,
  storeObservation,
  updateObservationEmbedding,
} from "../../src/db/index";
import { createGraphManager } from "../../src/graph/index";
import { createEdges } from "../../src/graph/linker";
import { makeEmbedding } from "./helpers/graph";

describe("graph linker", () => {
  describe("createEdges (integration)", () => {
    let db: Database;

    beforeEach(() => {
      db = createDatabase(":memory:");
      runMigrations(db);

      createSession(db, {
        claudeSessionId: "link-sess",
        project: "link-test",
        userPrompt: "Test",
      });
    });

    afterEach(() => {
      db.close();
    });

    it("creates session edges for observations in the same session", async () => {
      const obs1 = storeObservation(db, {
        claudeSessionId: "link-sess",
        project: "link-test",
        observation: {
          type: "feature",
          title: "Feature A",
          subtitle: null,
          narrative: "Built feature A",
          facts: [],
          concepts: [],
          filesRead: [],
          filesModified: ["src/a.ts"],
        },
        promptNumber: 1,
      });

      const obs2 = storeObservation(db, {
        claudeSessionId: "link-sess",
        project: "link-test",
        observation: {
          type: "feature",
          title: "Feature B",
          subtitle: null,
          narrative: "Built feature B",
          facts: [],
          concepts: [],
          filesRead: [],
          filesModified: ["src/a.ts"],
        },
        promptNumber: 2,
      });

      if (!obs1.ok || !obs2.ok) throw new Error("Setup failed");

      // Store embeddings to make them show up as candidates
      const emb1 = makeEmbedding(1);
      const emb2 = makeEmbedding(1.05);
      updateObservationEmbedding(db, obs1.value, emb1);
      updateObservationEmbedding(db, obs2.value, emb2);

      const gm = createGraphManager();
      const result = await createEdges(db, gm, { observationId: obs2.value });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.totalStored).toBeGreaterThan(0);
      }

      // Should have edges in SQLite
      const edgesResult = getAllEdges(db, {});
      expect(edgesResult.ok).toBe(true);
      if (edgesResult.ok) {
        expect(edgesResult.value.length).toBeGreaterThan(0);
      }

      // Graph should have nodes
      expect(gm.graph.order).toBeGreaterThan(0);
    });

    it("returns zeros when observation does not exist", async () => {
      const gm = createGraphManager();
      const result = await createEdges(db, gm, { observationId: 99999 });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.totalStored).toBe(0);
      }
    });

    it("handles observation with no embedding (no similarity edges)", async () => {
      const obs = storeObservation(db, {
        claudeSessionId: "link-sess",
        project: "link-test",
        observation: {
          type: "feature",
          title: "Solo observation",
          subtitle: null,
          narrative: "Just a test",
          facts: [],
          concepts: [],
          filesRead: [],
          filesModified: [],
        },
        promptNumber: 1,
      });

      if (!obs.ok) throw new Error("Setup failed");

      const gm = createGraphManager();
      const result = await createEdges(db, gm, { observationId: obs.value });

      expect(result.ok).toBe(true);
      // No candidates with embeddings, no session peers, so no edges
      if (result.ok) {
        expect(result.value.totalStored).toBe(0);
      }
    });
  });
});
