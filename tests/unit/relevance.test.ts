import { describe, expect, it } from "bun:test";
import {
  calculateFileOverlapScore,
  calculateRecencyScore,
  calculateSimilarityScore,
  calculateTypeScore,
  cosineSimilarity,
  type ScoringContext,
  scoreObservation,
} from "../../src/utils/relevance";

describe("calculateRecencyScore", () => {
  it("returns 1.0 for observations created right now", () => {
    const now = Date.now();
    expect(calculateRecencyScore(now, 2)).toBeCloseTo(1.0, 2);
  });

  it("returns ~0.5 after one half-life", () => {
    const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000;
    expect(calculateRecencyScore(twoDaysAgo, 2)).toBeCloseTo(0.5, 1);
  });

  it("returns ~0.25 after two half-lives", () => {
    const fourDaysAgo = Date.now() - 4 * 24 * 60 * 60 * 1000;
    expect(calculateRecencyScore(fourDaysAgo, 2)).toBeCloseTo(0.25, 1);
  });

  it("approaches 0 for very old observations", () => {
    const monthAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    expect(calculateRecencyScore(monthAgo, 2)).toBeLessThan(0.01);
  });

  it("uses custom half-life", () => {
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    expect(calculateRecencyScore(sevenDaysAgo, 7)).toBeCloseTo(0.5, 1);
  });
});

describe("calculateTypeScore", () => {
  it("scores decision highest", () => {
    expect(calculateTypeScore("decision")).toBe(0.8);
  });

  it("scores bugfix high", () => {
    expect(calculateTypeScore("bugfix")).toBe(0.7);
  });

  it("scores discovery medium-high", () => {
    expect(calculateTypeScore("discovery")).toBe(0.6);
  });

  it("scores feature medium", () => {
    expect(calculateTypeScore("feature")).toBe(0.5);
  });

  it("scores refactor low-medium", () => {
    expect(calculateTypeScore("refactor")).toBe(0.4);
  });

  it("scores change lowest", () => {
    expect(calculateTypeScore("change")).toBe(0.3);
  });

  it("returns 0.3 for unknown types", () => {
    expect(calculateTypeScore("unknown")).toBe(0.3);
  });
});

describe("calculateSimilarityScore", () => {
  it("returns 0 when no FTS rank and no concept overlap", () => {
    expect(calculateSimilarityScore(0, 0)).toBe(0);
  });

  it("returns up to 1.5 with perfect match", () => {
    expect(calculateSimilarityScore(1.0, 1.0)).toBeCloseTo(1.5, 1);
  });

  it("weighs FTS rank more heavily than concept overlap", () => {
    const ftsOnly = calculateSimilarityScore(1.0, 0);
    const conceptOnly = calculateSimilarityScore(0, 1.0);
    expect(ftsOnly).toBeGreaterThan(conceptOnly);
  });
});

describe("calculateFileOverlapScore", () => {
  it("returns 0 when no overlap", () => {
    expect(calculateFileOverlapScore(["a.ts", "b.ts"], ["c.ts", "d.ts"])).toBe(
      0,
    );
  });

  it("returns 1.0 for full overlap", () => {
    expect(calculateFileOverlapScore(["a.ts", "b.ts"], ["a.ts", "b.ts"])).toBe(
      1.0,
    );
  });

  it("returns 0.5 for half overlap", () => {
    expect(calculateFileOverlapScore(["a.ts", "b.ts"], ["a.ts", "c.ts"])).toBe(
      0.5,
    );
  });

  it("returns 0 when observation has no files", () => {
    expect(calculateFileOverlapScore([], ["a.ts"])).toBe(0);
  });

  it("returns 0 when cwd has no files", () => {
    expect(calculateFileOverlapScore(["a.ts"], [])).toBe(0);
  });

  it("matches partial file paths", () => {
    expect(
      calculateFileOverlapScore(
        ["src/utils/validation.ts"],
        ["src/utils/validation.ts", "src/hooks/logic.ts"],
      ),
    ).toBe(1.0);
  });
});

describe("cosineSimilarity", () => {
  it("returns 1.0 for identical normalized vectors", () => {
    const v = new Float32Array([0.6, 0.8]);
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0, 5);
  });

  it("returns 0 for orthogonal vectors", () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([0, 1]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0, 5);
  });

  it("returns -1 for opposite vectors", () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([-1, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1, 5);
  });

  it("returns 0 for empty arrays", () => {
    expect(cosineSimilarity(new Float32Array([]), new Float32Array([]))).toBe(
      0,
    );
  });

  it("returns 0 for mismatched lengths", () => {
    const a = new Float32Array([1, 2]);
    const b = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(a, b)).toBe(0);
  });

  it("handles non-normalized vectors", () => {
    const a = new Float32Array([3, 4]);
    const b = new Float32Array([6, 8]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(1.0, 5);
  });
});

describe("scoreObservation", () => {
  const makeContext = (
    overrides?: Partial<ScoringContext>,
  ): ScoringContext => ({
    currentProject: "my-project",
    cwdFiles: [],
    ftsRanks: new Map(),
    ...overrides,
  });

  const makeObs = (overrides?: Record<string, unknown>) => ({
    id: 1,
    sdkSessionId: "sess-1",
    project: "my-project",
    type: "discovery" as const,
    title: "Test observation",
    subtitle: null,
    narrative: null,
    facts: [] as readonly string[],
    concepts: [] as readonly string[],
    filesRead: [] as readonly string[],
    filesModified: [] as readonly string[],
    promptNumber: 1,
    discoveryTokens: 0,
    createdAt: new Date().toISOString(),
    createdAtEpoch: Date.now(),
    ...overrides,
  });

  it("gives same-project bonus to current project observations", () => {
    const ctx = makeContext({ currentProject: "my-project" });
    const sameProject = scoreObservation(
      makeObs({ project: "my-project" }),
      ctx,
    );
    const otherProject = scoreObservation(makeObs({ project: "other" }), ctx);
    expect(sameProject).toBeGreaterThan(otherProject);
  });

  it("lets high FTS rank override project bonus", () => {
    const ctx = makeContext({
      currentProject: "my-project",
      ftsRanks: new Map([[2, 1.0]]),
    });
    const highRankOther = scoreObservation(
      makeObs({ id: 2, project: "other" }),
      ctx,
    );
    const noRankSame = scoreObservation(
      makeObs({ id: 1, project: "my-project" }),
      ctx,
    );
    expect(highRankOther).toBeGreaterThan(noRankSame);
  });

  it("recency dominates for recent observations with no other signals", () => {
    const ctx = makeContext();
    const recent = scoreObservation(
      makeObs({ createdAtEpoch: Date.now() }),
      ctx,
    );
    const old = scoreObservation(
      makeObs({ createdAtEpoch: Date.now() - 7 * 24 * 60 * 60 * 1000 }),
      ctx,
    );
    expect(recent).toBeGreaterThan(old);
  });

  it("gives embedding bonus proportional to similarity score", () => {
    const embeddingScores = new Map<number, number>([[1, 0.9]]);
    const ctx = makeContext({ embeddingScores });
    const withEmbedding = scoreObservation(makeObs({ id: 1 }), ctx);
    const withoutEmbedding = scoreObservation(makeObs({ id: 2 }), ctx);
    expect(withEmbedding).toBeGreaterThan(withoutEmbedding);
  });

  it("applies configurable embedding bonus with similarity score", () => {
    const embeddingScores = new Map<number, number>([[1, 1.0]]);
    const ctx = makeContext({
      embeddingScores,
      config: {
        recencyHalfLifeDays: 2,
        sameProjectBonus: 0.1,
        ftsWeight: 1.0,
        conceptWeight: 0.5,
        embeddingBonus: 0.5,
      },
    });
    const withEmbedding = scoreObservation(makeObs({ id: 1 }), ctx);
    const withoutEmbedding = scoreObservation(makeObs({ id: 2 }), ctx);
    // 1.0 * 0.5 = 0.5 bonus
    expect(withEmbedding - withoutEmbedding).toBeCloseTo(0.5, 2);
  });

  it("gives partial embedding bonus for partial similarity", () => {
    const embeddingScores = new Map<number, number>([[1, 0.5]]);
    const ctx = makeContext({
      embeddingScores,
      config: {
        recencyHalfLifeDays: 2,
        sameProjectBonus: 0.1,
        ftsWeight: 1.0,
        conceptWeight: 0.5,
        embeddingBonus: 0.4,
      },
    });
    const withEmbedding = scoreObservation(makeObs({ id: 1 }), ctx);
    const withoutEmbedding = scoreObservation(makeObs({ id: 2 }), ctx);
    // 0.5 * 0.4 = 0.2 bonus
    expect(withEmbedding - withoutEmbedding).toBeCloseTo(0.2, 2);
  });

  it("gives no embedding bonus when embeddingScores is not provided", () => {
    const ctx = makeContext();
    const score1 = scoreObservation(makeObs({ id: 1 }), ctx);
    const score2 = scoreObservation(makeObs({ id: 2 }), ctx);
    expect(score1).toBeCloseTo(score2, 5);
  });
});
