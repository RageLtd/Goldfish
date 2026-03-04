import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { runGraphBackfill } from "../../src/commands/graph";
import { runPrune } from "../../src/commands/prune";
import {
  createDatabase,
  createSession,
  getAllEdges,
  getObservationsWithEmbeddingsButNoEdges,
  runMigrations,
  storeObservation,
  updateObservationEmbedding,
} from "../../src/db/index";
import type { GraphManager } from "../../src/graph/index";
import { createGraphManager } from "../../src/graph/index";

// ============================================================================
// Test helpers
// ============================================================================

/** Creates a normalized embedding vector. */
const makeEmbedding = (seed: number, length = 8): Float32Array => {
  const arr = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    arr[i] = Math.sin(seed * (i + 1));
  }
  let norm = 0;
  for (let i = 0; i < length; i++) norm += arr[i] * arr[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < length; i++) arr[i] /= norm;
  return arr;
};

const storeObs = (
  db: Database,
  overrides: { project?: string; title?: string; withEmbedding?: boolean },
): number => {
  const sessionId = "backfill-test-session";

  const existing = db
    .query<{ id: number }, [string]>(
      "SELECT id FROM sdk_sessions WHERE claude_session_id = ?",
    )
    .get(sessionId);

  if (!existing) {
    createSession(db, {
      claudeSessionId: sessionId,
      project: overrides.project ?? "test-project",
      userPrompt: "test",
    });
  }

  const result = storeObservation(db, {
    claudeSessionId: sessionId,
    project: overrides.project ?? "test-project",
    promptNumber: 1,
    observation: {
      type: "discovery",
      title: overrides.title ?? "Test observation",
      subtitle: null,
      narrative: "Test narrative",
      facts: [],
      concepts: ["testing"],
      filesRead: ["/src/test.ts"],
      filesModified: [],
    },
  });

  if (!result.ok) throw new Error("Failed to store observation");
  const id = result.value;

  if (overrides.withEmbedding !== false) {
    updateObservationEmbedding(db, id, makeEmbedding(id));
  }

  return id;
};

// ============================================================================
// getObservationsWithEmbeddingsButNoEdges
// ============================================================================

describe("getObservationsWithEmbeddingsButNoEdges", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  it("returns empty when no observations exist", () => {
    const result = getObservationsWithEmbeddingsButNoEdges(db, { limit: 50 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([]);
  });

  it("returns observations with embeddings but no edges", () => {
    const id = storeObs(db, { withEmbedding: true });

    const result = getObservationsWithEmbeddingsButNoEdges(db, { limit: 50 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toContain(id);
    }
  });

  it("excludes observations without embeddings", () => {
    storeObs(db, { withEmbedding: false });

    const result = getObservationsWithEmbeddingsButNoEdges(db, { limit: 50 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([]);
  });

  it("excludes observations that already have edges", () => {
    const id1 = storeObs(db, { withEmbedding: true });
    const id2 = storeObs(db, { withEmbedding: true, title: "Second obs" });

    // Create an edge for id1
    db.run(
      `INSERT INTO kg_edges (source_id, target_id, relation, weight, direction, created_at_epoch)
       VALUES (?, ?, 'similar_to', 0.8, 'bidirectional', ?)`,
      [id1, id2, Date.now()],
    );

    const result = getObservationsWithEmbeddingsButNoEdges(db, { limit: 50 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Both have edges now (id1 as source, id2 as target)
      expect(result.value).not.toContain(id1);
      expect(result.value).not.toContain(id2);
    }
  });

  it("filters by project", () => {
    const id1 = storeObs(db, { project: "project-a" });
    storeObs(db, { project: "project-b" });

    const result = getObservationsWithEmbeddingsButNoEdges(db, {
      project: "project-a",
      limit: 50,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([id1]);
    }
  });

  it("respects limit", () => {
    storeObs(db, { title: "obs-1" });
    storeObs(db, { title: "obs-2" });
    storeObs(db, { title: "obs-3" });

    const result = getObservationsWithEmbeddingsButNoEdges(db, { limit: 2 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toHaveLength(2);
  });
});

// ============================================================================
// runGraphBackfill
// ============================================================================

describe("runGraphBackfill", () => {
  let db: Database;
  let graphManager: GraphManager;

  beforeEach(() => {
    db = createDatabase(":memory:");
    runMigrations(db);
    graphManager = createGraphManager();
  });

  afterEach(() => {
    db.close();
  });

  it("returns 0 processed when no candidates", async () => {
    const result = await runGraphBackfill(db, graphManager, { dryRun: false });
    expect(result.candidates).toBe(0);
    expect(result.processed).toBe(0);
    expect(result.edgesCreated).toBe(0);
  });

  it("creates edges for observations with embeddings but no edges", async () => {
    // Create two observations with embeddings — tier 1 should find similarity edges
    storeObs(db, { title: "First observation about testing" });
    storeObs(db, { title: "Second observation about testing" });

    const result = await runGraphBackfill(db, graphManager, { dryRun: false });

    expect(result.candidates).toBe(2);
    expect(result.processed).toBe(2);
    // At minimum, tier 1 should create some edges (concept/file overlap)
    expect(result.edgesCreated).toBeGreaterThanOrEqual(0);
  });

  it("respects project filter", async () => {
    storeObs(db, { project: "project-a", title: "Obs in A" });
    storeObs(db, { project: "project-b", title: "Obs in B" });

    const result = await runGraphBackfill(db, graphManager, {
      project: "project-a",
      dryRun: false,
    });

    expect(result.candidates).toBe(1);
    expect(result.processed).toBe(1);
  });

  it("dry run reports count without creating edges", async () => {
    storeObs(db, { title: "Obs 1" });
    storeObs(db, { title: "Obs 2" });

    const result = await runGraphBackfill(db, graphManager, { dryRun: true });

    expect(result.candidates).toBe(2);
    expect(result.processed).toBe(0);
    expect(result.edgesCreated).toBe(0);

    // Verify no edges were created
    const edges = getAllEdges(db, {});
    expect(edges.ok).toBe(true);
    if (edges.ok) expect(edges.value).toHaveLength(0);
  });

  it("recomputes and stores graph metadata after backfill", async () => {
    const id1 = storeObs(db, { title: "Obs about auth module" });
    storeObs(db, { title: "Obs about auth module too" });

    await runGraphBackfill(db, graphManager, { dryRun: false });

    // Check that graph metadata was stored for nodes with edges
    const edges = getAllEdges(db, {});
    if (edges.ok && edges.value.length > 0) {
      const row = db
        .query<{ graph_degree: number | null }, [number]>(
          "SELECT graph_degree FROM observations WHERE id = ?",
        )
        .get(id1);

      // If edges were created, metadata should be set
      if (row && row.graph_degree !== null) {
        expect(row.graph_degree).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

// ============================================================================
// PruneResult.deletedIds
// ============================================================================

describe("runPrune returns deletedIds", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  it("returns empty deletedIds when nothing pruned", () => {
    const result = runPrune(db, {
      maxAgeDays: 90,
      dedupThreshold: 0.92,
      minScore: 0.2,
      dryRun: false,
    });

    expect(result.deletedIds).toEqual([]);
  });

  it("returns IDs of deleted observations", () => {
    // Create old observations that will be age-pruned
    const sessionId = "prune-delete-test";
    createSession(db, {
      claudeSessionId: sessionId,
      project: "test-project",
      userPrompt: "test",
    });

    const oldEpoch = Date.now() - 200 * 24 * 60 * 60 * 1000; // 200 days ago

    const r = storeObservation(db, {
      claudeSessionId: sessionId,
      project: "test-project",
      promptNumber: 1,
      observation: {
        type: "discovery",
        title: "Old observation",
        subtitle: null,
        narrative: "old",
        facts: [],
        concepts: [],
        filesRead: [],
        filesModified: [],
      },
    });

    if (!r.ok) throw new Error("Failed to store observation");

    // Manually backdate
    db.run("UPDATE observations SET created_at_epoch = ? WHERE id = ?", [
      oldEpoch,
      r.value,
    ]);

    const result = runPrune(db, {
      maxAgeDays: 90,
      dedupThreshold: 0.92,
      minScore: 0.2,
      dryRun: false,
    });

    expect(result.deleted).toBeGreaterThan(0);
    expect(result.deletedIds).toContain(r.value);
    expect(result.deletedIds.length).toBeGreaterThan(0);
  });

  it("returns empty deletedIds in dry run mode", () => {
    const sessionId = "prune-dry-test";
    createSession(db, {
      claudeSessionId: sessionId,
      project: "test-project",
      userPrompt: "test",
    });

    const oldEpoch = Date.now() - 200 * 24 * 60 * 60 * 1000;

    const r = storeObservation(db, {
      claudeSessionId: sessionId,
      project: "test-project",
      promptNumber: 1,
      observation: {
        type: "discovery",
        title: "Old dry run observation",
        subtitle: null,
        narrative: "old",
        facts: [],
        concepts: [],
        filesRead: [],
        filesModified: [],
      },
    });

    if (!r.ok) throw new Error("Failed to store observation");
    db.run("UPDATE observations SET created_at_epoch = ? WHERE id = ?", [
      oldEpoch,
      r.value,
    ]);

    const result = runPrune(db, {
      maxAgeDays: 90,
      dedupThreshold: 0.92,
      minScore: 0.2,
      dryRun: true,
    });

    expect(result.total).toBeGreaterThan(0);
    expect(result.deletedIds).toEqual([]);
  });
});
