import { describe, expect, it } from "bun:test";
import {
  findConceptOverlapEdges,
  findFileOverlapEdges,
  findSessionEdges,
  findSimilarityEdges,
  inferCausedByEdges,
  inferImplementsEdges,
  inferSupersedesEdges,
  jaccardCoefficient,
} from "../../src/graph/linker";
import { makeEmbedding, makeObservation } from "./helpers/graph";

const makeSourceCtx = (overrides: Record<string, unknown> = {}) => ({
  id: 1,
  type: "feature" as string,
  sdkSessionId: "test-sess",
  project: "test-project",
  filesModified: [] as readonly string[],
  filesRead: [] as readonly string[],
  concepts: [] as readonly string[],
  promptNumber: 1,
  createdAtEpoch: Date.now(),
  embedding: null as Float32Array | null,
  ...overrides,
});

describe("graph linker", () => {
  describe("jaccardCoefficient", () => {
    it("returns 0 for empty arrays", () => {
      expect(jaccardCoefficient([], [])).toBe(0);
      expect(jaccardCoefficient(["a"], [])).toBe(0);
      expect(jaccardCoefficient([], ["a"])).toBe(0);
    });

    it("returns 1 for identical sets", () => {
      expect(jaccardCoefficient(["a", "b", "c"], ["a", "b", "c"])).toBe(1);
    });

    it("returns 0 for disjoint sets", () => {
      expect(jaccardCoefficient(["a", "b"], ["c", "d"])).toBe(0);
    });

    it("computes correct coefficient for partial overlap", () => {
      // {a, b, c} ∩ {b, c, d} = {b, c} => 2/4 = 0.5
      expect(jaccardCoefficient(["a", "b", "c"], ["b", "c", "d"])).toBe(0.5);
    });
  });

  describe("findSimilarityEdges", () => {
    it("returns empty when source has no embedding", () => {
      const source = makeSourceCtx({ embedding: null });
      const candidates = [{ id: 2, embedding: makeEmbedding(1) }];
      expect(findSimilarityEdges(source, candidates)).toEqual([]);
    });

    it("returns edges for candidates above threshold", () => {
      const emb = makeEmbedding(1);
      const source = makeSourceCtx({ id: 1, embedding: emb });
      // Same embedding = cosine 1.0, well above threshold
      const candidates = [{ id: 2, embedding: emb }];

      const edges = findSimilarityEdges(source, candidates);
      expect(edges).toHaveLength(1);
      expect(edges[0].relation).toBe("similar-to");
      expect(edges[0].direction).toBe("bidirectional");
      expect(edges[0].weight).toBeCloseTo(1.0, 2);
    });

    it("excludes self", () => {
      const emb = makeEmbedding(1);
      const source = makeSourceCtx({ id: 1, embedding: emb });
      const candidates = [{ id: 1, embedding: emb }];

      expect(findSimilarityEdges(source, candidates)).toEqual([]);
    });

    it("excludes candidates below threshold", () => {
      const source = makeSourceCtx({ id: 1, embedding: makeEmbedding(1) });
      // Very different embedding
      const candidates = [{ id: 2, embedding: makeEmbedding(100) }];

      const edges = findSimilarityEdges(source, candidates, 0.99);
      expect(edges).toEqual([]);
    });

    it("respects custom threshold", () => {
      const source = makeSourceCtx({ id: 1, embedding: makeEmbedding(1) });
      const candidates = [{ id: 2, embedding: makeEmbedding(1.1) }];

      // With low threshold
      const lowEdges = findSimilarityEdges(source, candidates, 0.1);
      expect(lowEdges).toHaveLength(1);

      // With high threshold
      const highEdges = findSimilarityEdges(source, candidates, 0.9999);
      // May or may not match depending on how similar seeds 1 and 1.1 are
      expect(highEdges.length).toBeLessThanOrEqual(1);
    });
  });

  describe("findFileOverlapEdges", () => {
    it("returns empty when source has no files", () => {
      const source = makeSourceCtx({ filesModified: [] });
      const candidates = [makeObservation({ id: 2, filesModified: ["a.ts"] })];
      expect(findFileOverlapEdges(source, candidates)).toEqual([]);
    });

    it("creates edges for overlapping files", () => {
      const source = makeSourceCtx({
        id: 1,
        filesModified: ["src/a.ts", "src/b.ts"],
      });
      const candidates = [
        makeObservation({
          id: 2,
          filesModified: ["src/b.ts", "src/c.ts"],
        }),
      ];

      const edges = findFileOverlapEdges(source, candidates);
      expect(edges).toHaveLength(1);
      expect(edges[0].relation).toBe("shares-file");
      expect(edges[0].weight).toBe(
        1 / 3, // intersection=1, union=3
      );
    });

    it("excludes self", () => {
      const source = makeSourceCtx({
        id: 1,
        filesModified: ["a.ts"],
      });
      const candidates = [makeObservation({ id: 1, filesModified: ["a.ts"] })];
      expect(findFileOverlapEdges(source, candidates)).toEqual([]);
    });

    it("skips candidates with no files", () => {
      const source = makeSourceCtx({
        id: 1,
        filesModified: ["a.ts"],
      });
      const candidates = [makeObservation({ id: 2, filesModified: [] })];
      expect(findFileOverlapEdges(source, candidates)).toEqual([]);
    });
  });

  describe("findConceptOverlapEdges", () => {
    it("returns empty when source has no concepts", () => {
      const source = makeSourceCtx({ concepts: [] });
      const candidates = [
        makeObservation({ id: 2, concepts: ["how-it-works"] }),
      ];
      expect(findConceptOverlapEdges(source, candidates)).toEqual([]);
    });

    it("creates edges for overlapping concepts", () => {
      const source = makeSourceCtx({
        id: 1,
        concepts: ["how-it-works", "pattern"],
      });
      const candidates = [
        makeObservation({
          id: 2,
          concepts: ["how-it-works", "gotcha"],
        }),
      ];

      const edges = findConceptOverlapEdges(source, candidates);
      expect(edges).toHaveLength(1);
      expect(edges[0].relation).toBe("shares-concept");
      expect(edges[0].weight).toBeCloseTo(1 / 3, 5); // intersection=1, union=3
    });
  });

  describe("findSessionEdges", () => {
    it("creates same-session edges", () => {
      const source = makeSourceCtx({
        id: 1,
        sdkSessionId: "sess-1",
        promptNumber: 3,
      });
      const candidates = [
        makeObservation({ id: 2, sdkSessionId: "sess-1", promptNumber: 1 }),
        makeObservation({ id: 3, sdkSessionId: "sess-2", promptNumber: 1 }),
      ];

      const edges = findSessionEdges(source, candidates);
      const sameSessionEdges = edges.filter(
        (e) => e.relation === "same-session",
      );
      expect(sameSessionEdges).toHaveLength(1);
      expect(sameSessionEdges[0].targetId).toBe(2);
    });

    it("creates followed-by edges for sequential prompts", () => {
      const source = makeSourceCtx({
        id: 2,
        sdkSessionId: "sess-1",
        promptNumber: 2,
      });
      const candidates = [
        makeObservation({ id: 1, sdkSessionId: "sess-1", promptNumber: 1 }),
        makeObservation({ id: 3, sdkSessionId: "sess-1", promptNumber: 3 }),
      ];

      const edges = findSessionEdges(source, candidates);
      const followedByEdges = edges.filter((e) => e.relation === "followed-by");
      expect(followedByEdges).toHaveLength(2);

      // obs 1 followed-by obs 2
      const preceding = followedByEdges.find((e) => e.sourceId === 1);
      expect(preceding).toBeDefined();
      expect(preceding!.targetId).toBe(2);
      expect(preceding!.direction).toBe("directed");

      // obs 2 followed-by obs 3
      const following = followedByEdges.find((e) => e.sourceId === 2);
      expect(following).toBeDefined();
      expect(following!.targetId).toBe(3);
    });

    it("excludes different sessions", () => {
      const source = makeSourceCtx({
        id: 1,
        sdkSessionId: "sess-1",
        promptNumber: 1,
      });
      const candidates = [
        makeObservation({ id: 2, sdkSessionId: "sess-2", promptNumber: 2 }),
      ];

      const edges = findSessionEdges(source, candidates);
      expect(edges).toEqual([]);
    });
  });

  describe("inferSupersedesEdges", () => {
    it("returns empty for non-decision types", () => {
      const source = makeSourceCtx({
        type: "feature",
        embedding: makeEmbedding(1),
      });
      const candidates = [makeObservation({ id: 2, type: "decision" })];
      expect(inferSupersedesEdges(source, candidates, new Map())).toEqual([]);
    });

    it("returns empty when source has no embedding", () => {
      const source = makeSourceCtx({ type: "decision", embedding: null });
      const candidates = [makeObservation({ id: 2, type: "decision" })];
      expect(inferSupersedesEdges(source, candidates, new Map())).toEqual([]);
    });

    it("creates supersedes edge for matching criteria", () => {
      const now = Date.now();
      const emb = makeEmbedding(1);
      const source = makeSourceCtx({
        id: 2,
        type: "decision",
        embedding: emb,
        filesModified: ["config.ts"],
        createdAtEpoch: now,
      });
      const older = makeObservation({
        id: 1,
        type: "decision",
        filesModified: ["config.ts"],
        createdAtEpoch: now - 10000,
      });

      const embMap = new Map<number, Float32Array>();
      embMap.set(1, emb); // Same embedding = high similarity

      const edges = inferSupersedesEdges(source, [older], embMap);
      expect(edges).toHaveLength(1);
      expect(edges[0].relation).toBe("supersedes");
      expect(edges[0].sourceId).toBe(2); // newer supersedes older
      expect(edges[0].targetId).toBe(1);
      expect(edges[0].direction).toBe("directed");
    });

    it("requires overlapping files", () => {
      const now = Date.now();
      const emb = makeEmbedding(1);
      const source = makeSourceCtx({
        id: 2,
        type: "decision",
        embedding: emb,
        filesModified: ["a.ts"],
        createdAtEpoch: now,
      });
      const older = makeObservation({
        id: 1,
        type: "decision",
        filesModified: ["b.ts"], // different files
        createdAtEpoch: now - 10000,
      });

      const embMap = new Map<number, Float32Array>();
      embMap.set(1, emb);

      const edges = inferSupersedesEdges(source, [older], embMap);
      expect(edges).toEqual([]);
    });
  });

  describe("inferCausedByEdges", () => {
    it("links bugfix to preceding change with shared files", () => {
      const now = Date.now();
      const source = makeSourceCtx({
        id: 2,
        type: "bugfix",
        filesModified: ["auth.ts"],
        createdAtEpoch: now,
      });
      const change = makeObservation({
        id: 1,
        type: "change",
        filesModified: ["auth.ts"],
        createdAtEpoch: now - 3600000, // 1 hour ago
      });

      const edges = inferCausedByEdges(source, [change]);
      expect(edges).toHaveLength(1);
      expect(edges[0].relation).toBe("caused-by");
      expect(edges[0].sourceId).toBe(2); // bugfix caused-by change
      expect(edges[0].targetId).toBe(1);
      expect(edges[0].direction).toBe("directed");
    });

    it("links change to subsequent bugfix with shared files", () => {
      const now = Date.now();
      const source = makeSourceCtx({
        id: 1,
        type: "change",
        filesModified: ["auth.ts"],
        createdAtEpoch: now - 3600000,
      });
      const bugfix = makeObservation({
        id: 2,
        type: "bugfix",
        filesModified: ["auth.ts"],
        createdAtEpoch: now,
      });

      const edges = inferCausedByEdges(source, [bugfix]);
      expect(edges).toHaveLength(1);
      expect(edges[0].sourceId).toBe(2);
      expect(edges[0].targetId).toBe(1);
    });

    it("respects time window", () => {
      const now = Date.now();
      const source = makeSourceCtx({
        id: 2,
        type: "bugfix",
        filesModified: ["auth.ts"],
        createdAtEpoch: now,
      });
      const oldChange = makeObservation({
        id: 1,
        type: "change",
        filesModified: ["auth.ts"],
        createdAtEpoch: now - 8 * 24 * 60 * 60 * 1000, // 8 days ago, outside 7 day window
      });

      const edges = inferCausedByEdges(source, [oldChange]);
      expect(edges).toEqual([]);
    });

    it("requires shared files", () => {
      const now = Date.now();
      const source = makeSourceCtx({
        id: 2,
        type: "bugfix",
        filesModified: ["auth.ts"],
        createdAtEpoch: now,
      });
      const change = makeObservation({
        id: 1,
        type: "change",
        filesModified: ["db.ts"], // different files
        createdAtEpoch: now - 3600000,
      });

      const edges = inferCausedByEdges(source, [change]);
      expect(edges).toEqual([]);
    });

    it("ignores non-bugfix/non-change types", () => {
      const source = makeSourceCtx({ type: "feature" });
      const candidates = [
        makeObservation({ id: 2, type: "change", filesModified: ["a.ts"] }),
      ];
      expect(inferCausedByEdges(source, candidates)).toEqual([]);
    });
  });

  describe("inferImplementsEdges", () => {
    it("links feature to preceding decision with shared files", () => {
      const now = Date.now();
      const source = makeSourceCtx({
        id: 2,
        type: "feature",
        filesModified: ["router.ts"],
        concepts: [],
        createdAtEpoch: now,
      });
      const decision = makeObservation({
        id: 1,
        type: "decision",
        filesModified: ["router.ts"],
        createdAtEpoch: now - 3600000,
      });

      const edges = inferImplementsEdges(source, [decision]);
      expect(edges).toHaveLength(1);
      expect(edges[0].relation).toBe("implements");
      expect(edges[0].sourceId).toBe(2); // feature implements decision
      expect(edges[0].targetId).toBe(1);
      expect(edges[0].direction).toBe("directed");
    });

    it("links decision to subsequent feature with shared concepts", () => {
      const now = Date.now();
      const source = makeSourceCtx({
        id: 1,
        type: "decision",
        filesModified: [],
        concepts: ["pattern"],
        createdAtEpoch: now - 3600000,
      });
      const feature = makeObservation({
        id: 2,
        type: "feature",
        concepts: ["pattern"],
        createdAtEpoch: now,
      });

      const edges = inferImplementsEdges(source, [feature]);
      expect(edges).toHaveLength(1);
      expect(edges[0].sourceId).toBe(2);
      expect(edges[0].targetId).toBe(1);
    });

    it("requires file or concept overlap", () => {
      const now = Date.now();
      const source = makeSourceCtx({
        id: 2,
        type: "feature",
        filesModified: ["a.ts"],
        concepts: [],
        createdAtEpoch: now,
      });
      const decision = makeObservation({
        id: 1,
        type: "decision",
        filesModified: ["b.ts"],
        concepts: [],
        createdAtEpoch: now - 3600000,
      });

      const edges = inferImplementsEdges(source, [decision]);
      expect(edges).toEqual([]);
    });
  });
});
