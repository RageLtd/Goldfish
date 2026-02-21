import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { type PruneOptions, runPrune } from "../../src/commands/prune";
import {
  createSession,
  runMigrations,
  storeObservation,
} from "../../src/db/index";

const seedObservation = (
  db: Database,
  overrides: {
    title?: string;
    type?: string;
    epoch?: number;
    project?: string;
  } = {},
): void => {
  const sessionId = "prune-test-session";

  // Ensure session exists
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

  storeObservation(db, {
    claudeSessionId: sessionId,
    project: overrides.project ?? "test-project",
    promptNumber: 1,
    discoveryTokens: 100,
    observation: {
      type: (overrides.type as "discovery") ?? "discovery",
      title: overrides.title ?? "Test observation",
      subtitle: "subtitle",
      narrative: "narrative",
      facts: [],
      concepts: [],
      filesRead: [],
      filesModified: [],
    },
  });

  // Override epoch if provided
  if (overrides.epoch !== undefined) {
    const lastId = db
      .query<{ id: number }, []>("SELECT MAX(id) as id FROM observations")
      .get()?.id;
    if (lastId) {
      db.run("UPDATE observations SET created_at_epoch = ? WHERE id = ?", [
        overrides.epoch,
        lastId,
      ]);
    }
  }
};

describe("runPrune", () => {
  let db: Database;

  const defaultOptions: PruneOptions = {
    maxAgeDays: 90,
    dedupThreshold: 0.92,
    minScore: 0.2,
    dryRun: false,
  };

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  it("returns zeros when no observations exist", () => {
    const result = runPrune(db, defaultOptions);
    expect(result.total).toBe(0);
    expect(result.deleted).toBe(0);
  });

  it("does not delete in dry-run mode", () => {
    const oldEpoch = Date.now() - 120 * 24 * 60 * 60 * 1000; // 120 days ago
    seedObservation(db, { epoch: oldEpoch });

    const result = runPrune(db, { ...defaultOptions, dryRun: true });
    expect(result.aged).toBe(1);
    expect(result.total).toBe(1);
    expect(result.deleted).toBe(0);

    // Observation should still exist
    const count = db
      .query<{ c: number }, []>("SELECT COUNT(*) as c FROM observations")
      .get()?.c;
    expect(count).toBe(1);
  });

  it("deletes aged observations", () => {
    const oldEpoch = Date.now() - 120 * 24 * 60 * 60 * 1000;
    seedObservation(db, { epoch: oldEpoch, title: "Old obs" });
    seedObservation(db, { title: "Recent obs" }); // default epoch = now

    const result = runPrune(db, defaultOptions);
    expect(result.aged).toBe(1);
    // deleted includes FTS5 shadow table changes, so check > 0
    expect(result.deleted).toBeGreaterThan(0);

    const remaining = db
      .query<{ c: number }, []>("SELECT COUNT(*) as c FROM observations")
      .get()?.c;
    expect(remaining).toBe(1);
  });

  it("deletes low-score observations", () => {
    // Seed an observation — with no FTS query context and no project match,
    // score will be based on recency alone. A very high minScore catches most.
    seedObservation(db, { title: "Low value obs" });

    const result = runPrune(db, { ...defaultOptions, minScore: 999 });
    expect(result.lowScore).toBe(1);
    expect(result.deleted).toBeGreaterThan(0);

    const remaining = db
      .query<{ c: number }, []>("SELECT COUNT(*) as c FROM observations")
      .get()?.c;
    expect(remaining).toBe(0);
  });

  it("returns correct totals with no deletable observations", () => {
    seedObservation(db, { title: "Fresh important obs" });

    const result = runPrune(db, { ...defaultOptions, minScore: 0 });
    expect(result.total).toBe(0);
    expect(result.deleted).toBe(0);
  });
});
