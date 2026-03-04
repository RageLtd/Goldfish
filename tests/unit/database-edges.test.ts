import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  createDatabase,
  createSession,
  deleteEdgesByObservation,
  getAllEdges,
  getEdgesBetween,
  getEdgesByObservation,
  runMigrations,
  storeEdge,
  storeObservation,
  updateObservationGraphMetadata,
} from "../../src/db/index";

describe("database edges", () => {
  let db: Database;

  beforeEach(() => {
    // Use in-memory database for tests
    db = createDatabase(":memory:");
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  // ==========================================================================
  // Knowledge Graph Edge Operations
  // ==========================================================================

  describe("knowledge graph edges", () => {
    let obsId1: number;
    let obsId2: number;
    let obsId3: number;

    beforeEach(() => {
      createSession(db, {
        claudeSessionId: "kg-sess",
        project: "kg-test",
        userPrompt: "Test",
      });

      const r1 = storeObservation(db, {
        claudeSessionId: "kg-sess",
        project: "kg-test",
        observation: {
          type: "feature",
          title: "Add auth",
          subtitle: null,
          narrative: "Implemented auth",
          facts: [],
          concepts: ["how-it-works"],
          filesRead: [],
          filesModified: ["src/auth.ts"],
        },
        promptNumber: 1,
      });

      const r2 = storeObservation(db, {
        claudeSessionId: "kg-sess",
        project: "kg-test",
        observation: {
          type: "bugfix",
          title: "Fix auth timeout",
          subtitle: null,
          narrative: "Fixed timeout in auth",
          facts: [],
          concepts: ["problem-solution"],
          filesRead: [],
          filesModified: ["src/auth.ts"],
        },
        promptNumber: 2,
      });

      const r3 = storeObservation(db, {
        claudeSessionId: "kg-sess",
        project: "kg-test",
        observation: {
          type: "decision",
          title: "Use JWT",
          subtitle: null,
          narrative: "Decided to use JWT",
          facts: [],
          concepts: ["why-it-exists"],
          filesRead: [],
          filesModified: [],
        },
        promptNumber: 3,
      });

      if (!r1.ok || !r2.ok || !r3.ok) throw new Error("Setup failed");
      obsId1 = r1.value;
      obsId2 = r2.value;
      obsId3 = r3.value;
    });

    describe("storeEdge", () => {
      it("stores a new edge and returns its id", () => {
        const result = storeEdge(db, {
          sourceId: obsId1,
          targetId: obsId2,
          relation: "shares-file",
          weight: 0.8,
          direction: "bidirectional",
        });

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBeGreaterThan(0);
        }
      });

      it("is idempotent — returns existing id on duplicate", () => {
        const first = storeEdge(db, {
          sourceId: obsId1,
          targetId: obsId2,
          relation: "shares-file",
          weight: 0.8,
          direction: "bidirectional",
        });

        const second = storeEdge(db, {
          sourceId: obsId1,
          targetId: obsId2,
          relation: "shares-file",
          weight: 0.9,
          direction: "directed",
        });

        expect(first.ok).toBe(true);
        expect(second.ok).toBe(true);
        if (first.ok && second.ok) {
          expect(first.value).toBe(second.value);
        }
      });

      it("allows different relation types between same nodes", () => {
        const r1 = storeEdge(db, {
          sourceId: obsId1,
          targetId: obsId2,
          relation: "shares-file",
          weight: 0.8,
          direction: "bidirectional",
        });

        const r2 = storeEdge(db, {
          sourceId: obsId1,
          targetId: obsId2,
          relation: "same-session",
          weight: 1.0,
          direction: "bidirectional",
        });

        expect(r1.ok).toBe(true);
        expect(r2.ok).toBe(true);
        if (r1.ok && r2.ok) {
          expect(r1.value).not.toBe(r2.value);
        }
      });

      it("stores explanation and metadata", () => {
        const result = storeEdge(db, {
          sourceId: obsId1,
          targetId: obsId2,
          relation: "caused-by",
          weight: 0.7,
          direction: "directed",
          explanation: "Auth feature caused the timeout bug",
          metadata: { confidence: 0.85, signals: ["file-overlap", "temporal"] },
        });

        expect(result.ok).toBe(true);
        if (!result.ok) return;

        const edges = getEdgesBetween(db, {
          sourceId: obsId1,
          targetId: obsId2,
        });
        expect(edges.ok).toBe(true);
        if (edges.ok) {
          const edge = edges.value.find((e) => e.relation === "caused-by");
          expect(edge).toBeDefined();
          expect(edge!.explanation).toBe("Auth feature caused the timeout bug");
          expect(edge!.metadata).toEqual({
            confidence: 0.85,
            signals: ["file-overlap", "temporal"],
          });
        }
      });
    });

    describe("getEdgesByObservation", () => {
      it("returns edges where observation is source or target", () => {
        storeEdge(db, {
          sourceId: obsId1,
          targetId: obsId2,
          relation: "shares-file",
          weight: 0.8,
          direction: "bidirectional",
        });

        storeEdge(db, {
          sourceId: obsId3,
          targetId: obsId1,
          relation: "implements",
          weight: 0.6,
          direction: "directed",
        });

        const result = getEdgesByObservation(db, { observationId: obsId1 });
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toHaveLength(2);
        }
      });

      it("returns empty array when no edges exist", () => {
        const result = getEdgesByObservation(db, { observationId: obsId1 });
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toHaveLength(0);
        }
      });

      it("orders by weight descending", () => {
        storeEdge(db, {
          sourceId: obsId1,
          targetId: obsId2,
          relation: "shares-file",
          weight: 0.5,
          direction: "bidirectional",
        });

        storeEdge(db, {
          sourceId: obsId1,
          targetId: obsId3,
          relation: "same-session",
          weight: 1.0,
          direction: "bidirectional",
        });

        const result = getEdgesByObservation(db, { observationId: obsId1 });
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value[0].weight).toBe(1.0);
          expect(result.value[1].weight).toBe(0.5);
        }
      });
    });

    describe("getEdgesBetween", () => {
      it("returns edges in both directions between two nodes", () => {
        storeEdge(db, {
          sourceId: obsId1,
          targetId: obsId2,
          relation: "shares-file",
          weight: 0.8,
          direction: "bidirectional",
        });

        storeEdge(db, {
          sourceId: obsId2,
          targetId: obsId1,
          relation: "caused-by",
          weight: 0.6,
          direction: "directed",
        });

        const result = getEdgesBetween(db, {
          sourceId: obsId1,
          targetId: obsId2,
        });
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toHaveLength(2);
        }
      });

      it("returns empty when no edges exist between nodes", () => {
        const result = getEdgesBetween(db, {
          sourceId: obsId1,
          targetId: obsId3,
        });
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toHaveLength(0);
        }
      });
    });

    describe("getAllEdges", () => {
      it("returns all edges ordered by id", () => {
        storeEdge(db, {
          sourceId: obsId1,
          targetId: obsId2,
          relation: "shares-file",
          weight: 0.8,
          direction: "bidirectional",
        });

        storeEdge(db, {
          sourceId: obsId2,
          targetId: obsId3,
          relation: "same-session",
          weight: 1.0,
          direction: "bidirectional",
        });

        const result = getAllEdges(db, {});
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toHaveLength(2);
          expect(result.value[0].id).toBeLessThan(result.value[1].id);
        }
      });

      it("respects limit parameter", () => {
        storeEdge(db, {
          sourceId: obsId1,
          targetId: obsId2,
          relation: "shares-file",
          weight: 0.8,
          direction: "bidirectional",
        });

        storeEdge(db, {
          sourceId: obsId2,
          targetId: obsId3,
          relation: "same-session",
          weight: 1.0,
          direction: "bidirectional",
        });

        const result = getAllEdges(db, { limit: 1 });
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toHaveLength(1);
        }
      });
    });

    describe("deleteEdgesByObservation", () => {
      it("deletes all edges connected to an observation", () => {
        storeEdge(db, {
          sourceId: obsId1,
          targetId: obsId2,
          relation: "shares-file",
          weight: 0.8,
          direction: "bidirectional",
        });

        storeEdge(db, {
          sourceId: obsId3,
          targetId: obsId1,
          relation: "implements",
          weight: 0.6,
          direction: "directed",
        });

        // Edge not involving obsId1
        storeEdge(db, {
          sourceId: obsId2,
          targetId: obsId3,
          relation: "same-session",
          weight: 1.0,
          direction: "bidirectional",
        });

        const result = deleteEdgesByObservation(db, {
          observationId: obsId1,
        });
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe(2);
        }

        // The remaining edge should still exist
        const remaining = getAllEdges(db, {});
        expect(remaining.ok).toBe(true);
        if (remaining.ok) {
          expect(remaining.value).toHaveLength(1);
          expect(remaining.value[0].relation).toBe("same-session");
        }
      });

      it("returns 0 when no edges exist", () => {
        const result = deleteEdgesByObservation(db, {
          observationId: obsId1,
        });
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe(0);
        }
      });
    });

    describe("updateObservationGraphMetadata", () => {
      it("updates centrality, community, and degree", () => {
        const result = updateObservationGraphMetadata(db, {
          id: obsId1,
          centrality: 0.75,
          community: 2,
          degree: 5,
        });
        expect(result.ok).toBe(true);

        const obs = db
          .query<
            {
              graph_centrality: number | null;
              graph_community: number | null;
              graph_degree: number;
            },
            [number]
          >(
            "SELECT graph_centrality, graph_community, graph_degree FROM observations WHERE id = ?",
          )
          .get(obsId1);

        expect(obs).not.toBeNull();
        expect(obs!.graph_centrality).toBeCloseTo(0.75);
        expect(obs!.graph_community).toBe(2);
        expect(obs!.graph_degree).toBe(5);
      });

      it("allows null centrality and community", () => {
        const result = updateObservationGraphMetadata(db, {
          id: obsId1,
          centrality: null,
          community: null,
          degree: 0,
        });
        expect(result.ok).toBe(true);

        const obs = db
          .query<
            {
              graph_centrality: number | null;
              graph_community: number | null;
              graph_degree: number;
            },
            [number]
          >(
            "SELECT graph_centrality, graph_community, graph_degree FROM observations WHERE id = ?",
          )
          .get(obsId1);

        expect(obs).not.toBeNull();
        expect(obs!.graph_centrality).toBeNull();
        expect(obs!.graph_community).toBeNull();
        expect(obs!.graph_degree).toBe(0);
      });
    });

    describe("migration v8 — kg_edges table", () => {
      it("creates kg_edges table", () => {
        const row = db
          .query<{ name: string }, []>(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='kg_edges'",
          )
          .get();
        expect(row).not.toBeNull();
      });

      it("creates indexes on kg_edges", () => {
        const indexes = db
          .query<{ name: string }, []>(
            "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_kg_edges_%'",
          )
          .all();
        const names = indexes.map((i) => i.name);
        expect(names).toContain("idx_kg_edges_source");
        expect(names).toContain("idx_kg_edges_target");
        expect(names).toContain("idx_kg_edges_relation");
      });
    });

    describe("migration v9 — graph metadata columns", () => {
      it("adds graph_centrality column", () => {
        const obs = db
          .query<{ graph_centrality: number | null }, [number]>(
            "SELECT graph_centrality FROM observations WHERE id = ?",
          )
          .get(obsId1);
        expect(obs).not.toBeNull();
        expect(obs!.graph_centrality).toBeNull();
      });

      it("adds graph_degree column with default 0", () => {
        const obs = db
          .query<{ graph_degree: number }, [number]>(
            "SELECT graph_degree FROM observations WHERE id = ?",
          )
          .get(obsId1);
        expect(obs).not.toBeNull();
        expect(obs!.graph_degree).toBe(0);
      });
    });
  });
});
