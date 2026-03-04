import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  createDatabase,
  createSession,
  runMigrations,
} from "../../src/db/index";
import { SAME_PROJECT_BONUS } from "../../src/graph/index";
import {
  handleFindByFile,
  handleGetDecisions,
  handleGetTimeline,
  handleRetrieve,
  handleSearch,
  type WorkerDeps,
} from "../../src/worker/handlers";

describe("worker handlers", () => {
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

  describe("handleSearch", () => {
    it("returns 503 for observations when graphManager unavailable", async () => {
      const result = await handleSearch(deps, {
        query: "authentication",
        type: "observations",
        limit: 10,
      });

      expect(result.status).toBe(503);
    });

    it("returns 400 for invalid type", async () => {
      const result = await handleSearch(deps, {
        query: "test",
        // @ts-expect-error Testing invalid type
        type: "invalid",
        limit: 10,
      });

      expect(result.status).toBe(400);
    });
  });

  describe("handleGetTimeline", () => {
    it("returns timeline of observations and summaries", async () => {
      createSession(db, {
        claudeSessionId: "claude-123",
        project: "test-project",
        userPrompt: "Test",
      });

      const result = await handleGetTimeline(deps, {
        project: "test-project",
        limit: 10,
      });

      expect(result.status).toBe(200);
      expect(Array.isArray(result.body.results)).toBe(true);
      expect(typeof result.body.count).toBe("number");
    });

    it("works without project filter", async () => {
      const result = await handleGetTimeline(deps, {
        limit: 10,
      });

      expect(result.status).toBe(200);
      expect(Array.isArray(result.body.results)).toBe(true);
    });

    it("respects limit parameter", async () => {
      const result = await handleGetTimeline(deps, {
        limit: 5,
      });

      expect(result.status).toBe(200);
      expect(result.body.results.length).toBeLessThanOrEqual(5);
    });
  });

  describe("handleGetDecisions", () => {
    it("returns decisions filtered by type", async () => {
      createSession(db, {
        claudeSessionId: "claude-123",
        project: "test-project",
        userPrompt: "Test",
      });

      const result = await handleGetDecisions(deps, {
        project: "test-project",
        limit: 10,
      });

      expect(result.status).toBe(200);
      expect(Array.isArray(result.body.results)).toBe(true);
      // All results should be type=decision (or empty if none)
      for (const obs of result.body.results) {
        expect(obs.type).toBe("decision");
      }
    });

    it("works without project filter", async () => {
      const result = await handleGetDecisions(deps, {
        limit: 10,
      });

      expect(result.status).toBe(200);
      expect(Array.isArray(result.body.results)).toBe(true);
    });

    it("respects limit parameter", async () => {
      const result = await handleGetDecisions(deps, {
        limit: 3,
      });

      expect(result.status).toBe(200);
      expect(result.body.results.length).toBeLessThanOrEqual(3);
    });
  });

  describe("handleFindByFile", () => {
    it("finds observations by file path", async () => {
      createSession(db, {
        claudeSessionId: "claude-123",
        project: "test-project",
        userPrompt: "Test",
      });

      const result = await handleFindByFile(deps, {
        file: "login.ts",
        limit: 10,
      });

      expect(result.status).toBe(200);
      expect(Array.isArray(result.body.results)).toBe(true);
    });

    it("returns 400 for missing file parameter", async () => {
      const result = await handleFindByFile(deps, {
        file: "",
        limit: 10,
      });

      expect(result.status).toBe(400);
      expect(result.body.error).toContain("file parameter is required");
    });

    it("respects limit parameter", async () => {
      const result = await handleFindByFile(deps, {
        file: "src",
        limit: 5,
      });

      expect(result.status).toBe(200);
      expect(result.body.results.length).toBeLessThanOrEqual(5);
    });
  });
});

describe("handleSearch — graph-based", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  it("returns 503 when modelManager or graphManager unavailable", async () => {
    const result = await handleSearch(
      { db },
      { query: "test", type: "observations", limit: 10 },
    );
    expect(result.status).toBe(503);
  });
});

describe("handleRetrieve", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  it("skips retrieval when sessionId has no existing session", async () => {
    const result = await handleRetrieve(
      { db },
      {
        prompt: "fix the auth bug",
        project: "test-project",
        limit: 20,
        sessionId: "nonexistent-session",
      },
    );

    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      context: null,
      observationCount: 0,
      typeCounts: {},
    });
  });

  it("proceeds with retrieval when session exists", async () => {
    createSession(db, {
      claudeSessionId: "claude-existing",
      project: "test-project",
      userPrompt: "Initial",
    });

    // Without a model manager, retrieval returns 503
    const result = await handleRetrieve(
      { db },
      {
        prompt: "fix the auth bug",
        project: "test-project",
        limit: 20,
        sessionId: "claude-existing",
      },
    );

    // Should NOT short-circuit — proceeds to model check and returns 503
    expect(result.status).toBe(503);
  });

  it("proceeds with retrieval when no sessionId provided", async () => {
    const result = await handleRetrieve(
      { db },
      {
        prompt: "fix the auth bug",
        project: "test-project",
        limit: 20,
      },
    );

    // Without model manager, returns 503 (didn't short-circuit)
    expect(result.status).toBe(503);
  });

  it("exports SAME_PROJECT_BONUS as a positive number", () => {
    expect(SAME_PROJECT_BONUS).toBeGreaterThan(0);
    expect(SAME_PROJECT_BONUS).toBeLessThan(1);
  });
});
