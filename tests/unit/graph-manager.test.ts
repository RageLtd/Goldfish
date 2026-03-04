import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  createDatabase,
  createSession,
  runMigrations,
  storeEdge,
  storeObservation,
} from "../../src/db/index";
import type { GraphManager } from "../../src/graph/index";
import { createGraphManager } from "../../src/graph/index";

describe("graph manager", () => {
  let db: Database;
  let obsId1: number;
  let obsId2: number;
  let obsId3: number;
  let obsId4: number;

  beforeEach(() => {
    db = createDatabase(":memory:");
    runMigrations(db);

    createSession(db, {
      claudeSessionId: "gm-sess",
      project: "gm-test",
      userPrompt: "Test",
    });

    const ids = [1, 2, 3, 4].map((n) => {
      const r = storeObservation(db, {
        claudeSessionId: "gm-sess",
        project: "gm-test",
        observation: {
          type: "feature",
          title: `Obs ${n}`,
          subtitle: null,
          narrative: `Observation ${n}`,
          facts: [],
          concepts: [],
          filesRead: [],
          filesModified: [],
        },
        promptNumber: n,
      });
      if (!r.ok) throw new Error("Setup failed");
      return r.value;
    });

    obsId1 = ids[0];
    obsId2 = ids[1];
    obsId3 = ids[2];
    obsId4 = ids[3];
  });

  afterEach(() => {
    db.close();
  });

  describe("createGraphManager", () => {
    it("returns an object with expected methods", () => {
      const gm = createGraphManager();
      expect(gm.graph).toBeDefined();
      expect(typeof gm.hydrate).toBe("function");
      expect(typeof gm.addEdge).toBe("function");
      expect(typeof gm.removeNode).toBe("function");
      expect(typeof gm.getNeighborhood).toBe("function");
      expect(typeof gm.recomputeMetadata).toBe("function");
    });
  });

  describe("hydrate", () => {
    it("loads edges from SQLite into the graph", () => {
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

      const gm = createGraphManager();
      const result = gm.hydrate(db);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(2);
      }
      expect(gm.graph.order).toBe(3); // 3 nodes
      expect(gm.graph.size).toBe(2); // 2 edges
    });

    it("returns 0 when no edges exist", () => {
      const gm = createGraphManager();
      const result = gm.hydrate(db);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(0);
      }
      expect(gm.graph.order).toBe(0);
    });
  });

  describe("addEdge", () => {
    it("adds nodes and edges to the graph", () => {
      const gm = createGraphManager();
      gm.addEdge({
        id: 1,
        sourceId: obsId1,
        targetId: obsId2,
        relation: "shares-file",
        weight: 0.8,
        direction: "bidirectional",
        explanation: null,
        metadata: null,
        createdAtEpoch: Date.now(),
      });

      expect(gm.graph.order).toBe(2);
      expect(gm.graph.size).toBe(1);
    });

    it("is idempotent — does not add duplicate edges", () => {
      const gm = createGraphManager();
      const edge = {
        id: 1,
        sourceId: obsId1,
        targetId: obsId2,
        relation: "shares-file" as const,
        weight: 0.8,
        direction: "bidirectional" as const,
        explanation: null,
        metadata: null,
        createdAtEpoch: Date.now(),
      };

      gm.addEdge(edge);
      gm.addEdge(edge);

      expect(gm.graph.size).toBe(1);
    });

    it("adds directed edges correctly", () => {
      const gm = createGraphManager();
      gm.addEdge({
        id: 1,
        sourceId: obsId1,
        targetId: obsId2,
        relation: "caused-by",
        weight: 0.7,
        direction: "directed",
        explanation: null,
        metadata: null,
        createdAtEpoch: Date.now(),
      });

      expect(gm.graph.size).toBe(1);
      expect(gm.graph.hasDirectedEdge(String(obsId1), String(obsId2))).toBe(
        true,
      );
    });
  });

  describe("removeNode", () => {
    it("removes a node and its edges", () => {
      const gm = createGraphManager();
      gm.addEdge({
        id: 1,
        sourceId: obsId1,
        targetId: obsId2,
        relation: "shares-file",
        weight: 0.8,
        direction: "bidirectional",
        explanation: null,
        metadata: null,
        createdAtEpoch: Date.now(),
      });

      gm.addEdge({
        id: 2,
        sourceId: obsId2,
        targetId: obsId3,
        relation: "same-session",
        weight: 1.0,
        direction: "bidirectional",
        explanation: null,
        metadata: null,
        createdAtEpoch: Date.now(),
      });

      gm.removeNode(obsId2);

      expect(gm.graph.order).toBe(2); // obsId1 and obsId3 remain
      expect(gm.graph.size).toBe(0); // all edges through obsId2 gone
      expect(gm.graph.hasNode(String(obsId2))).toBe(false);
    });

    it("does nothing for non-existent nodes", () => {
      const gm = createGraphManager();
      gm.removeNode(99999); // should not throw
      expect(gm.graph.order).toBe(0);
    });
  });

  describe("getNeighborhood", () => {
    let gm: GraphManager;

    beforeEach(() => {
      gm = createGraphManager();
      // Chain: 1 -- 2 -- 3 -- 4
      gm.addEdge({
        id: 1,
        sourceId: obsId1,
        targetId: obsId2,
        relation: "shares-file",
        weight: 0.8,
        direction: "bidirectional",
        explanation: null,
        metadata: null,
        createdAtEpoch: Date.now(),
      });

      gm.addEdge({
        id: 2,
        sourceId: obsId2,
        targetId: obsId3,
        relation: "same-session",
        weight: 1.0,
        direction: "bidirectional",
        explanation: null,
        metadata: null,
        createdAtEpoch: Date.now(),
      });

      gm.addEdge({
        id: 3,
        sourceId: obsId3,
        targetId: obsId4,
        relation: "followed-by",
        weight: 0.9,
        direction: "bidirectional",
        explanation: null,
        metadata: null,
        createdAtEpoch: Date.now(),
      });
    });

    it("returns direct neighbors at depth 1", () => {
      const neighbors = gm.getNeighborhood(obsId1, 1);
      expect(neighbors).toEqual([obsId2]);
    });

    it("returns 2-hop neighbors at depth 2", () => {
      const neighbors = gm.getNeighborhood(obsId1, 2);
      expect(neighbors).toContain(obsId2);
      expect(neighbors).toContain(obsId3);
      expect(neighbors).not.toContain(obsId4);
    });

    it("returns all nodes at sufficient depth", () => {
      const neighbors = gm.getNeighborhood(obsId1, 3);
      expect(neighbors).toHaveLength(3);
      expect(neighbors).toContain(obsId2);
      expect(neighbors).toContain(obsId3);
      expect(neighbors).toContain(obsId4);
    });

    it("returns empty for non-existent node", () => {
      const neighbors = gm.getNeighborhood(99999, 2);
      expect(neighbors).toEqual([]);
    });

    it("does not include the seed node itself", () => {
      const neighbors = gm.getNeighborhood(obsId2, 3);
      expect(neighbors).not.toContain(obsId2);
    });
  });

  describe("recomputeMetadata", () => {
    it("computes centrality, community, and degree for all nodes", () => {
      const gm = createGraphManager();

      // Hub-and-spoke: obsId2 is the hub
      gm.addEdge({
        id: 1,
        sourceId: obsId1,
        targetId: obsId2,
        relation: "shares-file",
        weight: 0.8,
        direction: "bidirectional",
        explanation: null,
        metadata: null,
        createdAtEpoch: Date.now(),
      });

      gm.addEdge({
        id: 2,
        sourceId: obsId2,
        targetId: obsId3,
        relation: "same-session",
        weight: 1.0,
        direction: "bidirectional",
        explanation: null,
        metadata: null,
        createdAtEpoch: Date.now(),
      });

      gm.addEdge({
        id: 3,
        sourceId: obsId2,
        targetId: obsId4,
        relation: "followed-by",
        weight: 0.9,
        direction: "bidirectional",
        explanation: null,
        metadata: null,
        createdAtEpoch: Date.now(),
      });

      const metadata = gm.recomputeMetadata();

      // All 4 nodes should have metadata
      expect(metadata.size).toBe(4);

      // Hub (obsId2) should have highest degree
      const hubMeta = metadata.get(obsId2);
      expect(hubMeta).toBeDefined();
      expect(hubMeta!.degree).toBe(3);

      // Spokes should have degree 1
      const spokeMeta = metadata.get(obsId1);
      expect(spokeMeta).toBeDefined();
      expect(spokeMeta!.degree).toBe(1);

      // Hub should have highest centrality
      expect(hubMeta!.centrality).toBeGreaterThan(spokeMeta!.centrality);
    });

    it("returns empty map for empty graph", () => {
      const gm = createGraphManager();
      const metadata = gm.recomputeMetadata();
      expect(metadata.size).toBe(0);
    });

    it("handles disconnected nodes", () => {
      const gm = createGraphManager();
      gm.addEdge({
        id: 1,
        sourceId: obsId1,
        targetId: obsId2,
        relation: "shares-file",
        weight: 0.8,
        direction: "bidirectional",
        explanation: null,
        metadata: null,
        createdAtEpoch: Date.now(),
      });

      const metadata = gm.recomputeMetadata();
      expect(metadata.size).toBe(2);

      for (const [, meta] of metadata) {
        expect(typeof meta.community).toBe("number");
      }
    });
  });
});
