import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  createDatabase,
  createSession,
  runMigrations,
  storeEdge,
  storeObservation,
} from "../../src/db/index";
import { createGraphManager } from "../../src/graph/index";
import {
  handleGetNeighbors,
  handleGraphBackfill,
  handleGraphStats,
  type WorkerDeps,
} from "../../src/worker/handlers";

describe("graph handlers", () => {
  let db: Database;
  let deps: WorkerDeps;

  beforeEach(() => {
    db = createDatabase(":memory:");
    runMigrations(db);
    deps = { db };
  });

  afterEach(() => {
    db.close();
  });

  const setupObservations = () => {
    createSession(db, {
      claudeSessionId: "sess-1",
      project: "test-project",
      userPrompt: "test",
    });

    const id1 = storeObservation(db, {
      claudeSessionId: "sess-1",
      project: "test-project",
      promptNumber: 1,
      observation: {
        type: "feature",
        title: "Feature A",
        subtitle: null,
        narrative: "Built feature A",
        facts: [],
        concepts: [],
        filesRead: [],
        filesModified: [],
      },
    });

    const id2 = storeObservation(db, {
      claudeSessionId: "sess-1",
      project: "test-project",
      promptNumber: 2,
      observation: {
        type: "bugfix",
        title: "Fix B",
        subtitle: null,
        narrative: "Fixed bug B",
        facts: [],
        concepts: [],
        filesRead: [],
        filesModified: [],
      },
    });

    if (!id1.ok || !id2.ok) throw new Error("Setup failed");
    return { id1: id1.value, id2: id2.value };
  };

  describe("handleGetNeighbors", () => {
    it("returns 503 when no graphManager", async () => {
      const result = await handleGetNeighbors(deps, { id: 1 });
      expect(result.status).toBe(503);
    });

    it("returns neighbors for observation with edges", async () => {
      const { id1, id2 } = setupObservations();
      const gm = createGraphManager();

      storeEdge(db, {
        sourceId: id1,
        targetId: id2,
        relation: "relates-to",
        weight: 0.8,
        direction: "bidirectional",
      });
      gm.hydrate(db);

      const depsWithGraph = { ...deps, graphManager: gm };
      const result = await handleGetNeighbors(depsWithGraph, { id: id1 });

      expect(result.status).toBe(200);
      const body = result.body as {
        observationId: number;
        neighbors: { nodeId: number; title: string; relation: string }[];
      };
      expect(body.observationId).toBe(id1);
      expect(body.neighbors.length).toBe(1);
      expect(body.neighbors[0].nodeId).toBe(id2);
      expect(body.neighbors[0].title).toBe("Fix B");
      expect(body.neighbors[0].relation).toBe("relates-to");
    });

    it("returns empty neighbors for observation with no edges", async () => {
      setupObservations();
      const gm = createGraphManager();
      const depsWithGraph = { ...deps, graphManager: gm };

      const result = await handleGetNeighbors(depsWithGraph, { id: 1 });

      expect(result.status).toBe(200);
      const body = result.body as {
        observationId: number;
        neighbors: unknown[];
      };
      expect(body.neighbors).toEqual([]);
    });
  });

  describe("handleGraphStats", () => {
    it("returns 503 when no graphManager", async () => {
      const result = await handleGraphStats(deps);
      expect(result.status).toBe(503);
    });

    it("returns node/edge counts and community info", async () => {
      const { id1, id2 } = setupObservations();
      const gm = createGraphManager();

      storeEdge(db, {
        sourceId: id1,
        targetId: id2,
        relation: "relates-to",
        weight: 0.8,
        direction: "bidirectional",
      });
      gm.hydrate(db);

      const depsWithGraph = { ...deps, graphManager: gm };
      const result = await handleGraphStats(depsWithGraph);

      expect(result.status).toBe(200);
      const body = result.body as {
        nodes: number;
        edges: number;
        communities: number;
        topCentral: { id: number; title: string }[];
      };
      expect(body.nodes).toBe(2);
      expect(body.edges).toBe(1);
      expect(body.communities).toBeGreaterThanOrEqual(1);
      expect(body.topCentral.length).toBe(2);
    });

    it("returns empty stats for graph with no edges", async () => {
      const gm = createGraphManager();
      const depsWithGraph = { ...deps, graphManager: gm };
      const result = await handleGraphStats(depsWithGraph);

      expect(result.status).toBe(200);
      const body = result.body as {
        nodes: number;
        edges: number;
        topCentral: unknown[];
      };
      expect(body.nodes).toBe(0);
      expect(body.edges).toBe(0);
      expect(body.topCentral).toEqual([]);
    });
  });

  describe("handleGraphBackfill", () => {
    it("returns 503 when no graphManager", async () => {
      const result = await handleGraphBackfill(deps);
      expect(result.status).toBe(503);
    });

    it("returns backfill results", async () => {
      const gm = createGraphManager();
      const depsWithGraph = { ...deps, graphManager: gm };
      const result = await handleGraphBackfill(depsWithGraph);

      expect(result.status).toBe(200);
      const body = result.body as {
        candidates: number;
        processed: number;
        edgesCreated: number;
      };
      expect(body.candidates).toBe(0);
      expect(body.processed).toBe(0);
      expect(body.edgesCreated).toBe(0);
    });
  });
});
