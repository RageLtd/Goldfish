import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  createDatabase,
  createSession,
  runMigrations,
  storeEdge,
  storeObservation,
} from "../../src/db/index";
import { createGraphManager, expandSeeds } from "../../src/graph/index";
import type { ScoredSeed } from "../../src/graph/retrieval";
import type { Observation } from "../../src/types/domain";
import { makeObservation } from "./helpers/graph";

// ============================================================================
// Integration tests: expandSeeds
// ============================================================================

describe("graph retrieval", () => {
  describe("expandSeeds", () => {
    let db: Database;

    beforeEach(() => {
      db = createDatabase(":memory:");
      runMigrations(db);
      createSession(db, {
        claudeSessionId: "expand-sess",
        project: "expand-test",
        userPrompt: "Test",
      });
    });

    afterEach(() => {
      db.close();
    });

    it("returns seed observations when graph has no edges", () => {
      const obs1 = storeObservation(db, {
        claudeSessionId: "expand-sess",
        project: "expand-test",
        observation: {
          type: "feature",
          title: "Obs 1",
          subtitle: null,
          narrative: "First observation",
          facts: [],
          concepts: [],
          filesRead: [],
          filesModified: [],
        },
        promptNumber: 1,
      });

      if (!obs1.ok) throw new Error("Setup failed");

      const gm = createGraphManager();
      const candidateMap = new Map<number, Observation>();
      candidateMap.set(obs1.value, makeObservation({ id: obs1.value }));

      const seeds: ScoredSeed[] = [
        { observationId: obs1.value, activation: 0.8 },
      ];

      const result = expandSeeds({
        db,
        graphManager: gm,
        seeds,
        candidateMap,
        limit: 10,
      });

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(obs1.value);
    });

    it("includes graph-discovered observations", () => {
      const obs1 = storeObservation(db, {
        claudeSessionId: "expand-sess",
        project: "expand-test",
        observation: {
          type: "feature",
          title: "Seed obs",
          subtitle: null,
          narrative: "Seed",
          facts: [],
          concepts: [],
          filesRead: [],
          filesModified: [],
        },
        promptNumber: 1,
      });

      const obs2 = storeObservation(db, {
        claudeSessionId: "expand-sess",
        project: "expand-test",
        observation: {
          type: "bugfix",
          title: "Graph neighbor",
          subtitle: null,
          narrative: "Discovered via graph",
          facts: [],
          concepts: [],
          filesRead: [],
          filesModified: [],
        },
        promptNumber: 2,
      });

      if (!obs1.ok || !obs2.ok) throw new Error("Setup failed");

      const gm = createGraphManager();
      // Create edge between obs1 and obs2
      storeEdge(db, {
        sourceId: obs1.value,
        targetId: obs2.value,
        relation: "similar-to",
        weight: 0.8,
        direction: "bidirectional",
      });
      gm.hydrate(db);

      const candidateMap = new Map<number, Observation>();
      candidateMap.set(obs1.value, makeObservation({ id: obs1.value }));
      candidateMap.set(
        obs2.value,
        makeObservation({ id: obs2.value, title: "Graph neighbor" }),
      );

      const seeds: ScoredSeed[] = [
        { observationId: obs1.value, activation: 0.8 },
      ];

      const result = expandSeeds({
        db,
        graphManager: gm,
        seeds,
        candidateMap,
        limit: 10,
      });

      expect(result.length).toBeGreaterThanOrEqual(2);
      expect(result.some((o) => o.id === obs2.value)).toBe(true);
    });

    it("respects limit", () => {
      const ids: number[] = [];
      for (let i = 1; i <= 5; i++) {
        const r = storeObservation(db, {
          claudeSessionId: "expand-sess",
          project: "expand-test",
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
          promptNumber: i,
        });
        if (!r.ok) throw new Error("Setup failed");
        ids.push(r.value);
      }

      const gm = createGraphManager();
      const candidateMap = new Map<number, Observation>();
      for (const id of ids) {
        candidateMap.set(id, makeObservation({ id }));
      }

      const seeds = ids.map((id) => ({
        observationId: id,
        activation: 0.7,
      }));

      const result = expandSeeds({
        db,
        graphManager: gm,
        seeds,
        candidateMap,
        limit: 3,
      });

      expect(result).toHaveLength(3);
    });

    it("falls back to DB when observation not in candidateMap", () => {
      const obs = storeObservation(db, {
        claudeSessionId: "expand-sess",
        project: "expand-test",
        observation: {
          type: "feature",
          title: "DB lookup obs",
          subtitle: null,
          narrative: "Retrieved from DB",
          facts: [],
          concepts: [],
          filesRead: [],
          filesModified: [],
        },
        promptNumber: 1,
      });

      if (!obs.ok) throw new Error("Setup failed");

      const gm = createGraphManager();
      // Empty candidateMap — should fall back to DB
      const candidateMap = new Map<number, Observation>();
      const seeds: ScoredSeed[] = [
        { observationId: obs.value, activation: 0.8 },
      ];

      const result = expandSeeds({
        db,
        graphManager: gm,
        seeds,
        candidateMap,
        limit: 10,
      });

      expect(result).toHaveLength(1);
      expect(result[0].title).toBe("DB lookup obs");
    });
  });
});
