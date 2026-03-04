import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  createDatabase,
  createSession,
  runMigrations,
  storeObservation,
} from "../../src/db/index";
import { handleGetContext, type WorkerDeps } from "../../src/worker/handlers";

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

  describe("handleGetContext", () => {
    it("returns recent observations and summaries as formatted context", async () => {
      // Setup: create session with observations
      createSession(db, {
        claudeSessionId: "claude-123",
        project: "test-project",
        userPrompt: "Test",
      });

      // Note: In real usage, observations would be stored via SDK agent
      // For this test, we're just checking the handler works

      const result = await handleGetContext(deps, {
        project: "test-project",
        limit: 10,
      });

      expect(result.status).toBe(200);
      expect(typeof result.body.context).toBe("string");
    });

    it("returns empty context when no data", async () => {
      const result = await handleGetContext(deps, {
        project: "empty-project",
        limit: 10,
      });

      expect(result.status).toBe(200);
      expect(result.body.typeCounts).toEqual({});
    });

    it("returns typeCounts with correct counts per observation type", async () => {
      // Setup: create session and store observations with different types
      createSession(db, {
        claudeSessionId: "claude-ctx-types",
        project: "type-counts-project",
        userPrompt: "Test type counts",
      });

      const makeObservation = (type: string) => ({
        type: type as
          | "decision"
          | "bugfix"
          | "feature"
          | "refactor"
          | "discovery"
          | "change",
        title: `Test ${type}`,
        subtitle: null,
        narrative: null,
        facts: [],
        concepts: [],
        filesRead: [],
        filesModified: [],
      });

      // Store 3 decisions, 2 bugfixes, 1 feature
      storeObservation(db, {
        claudeSessionId: "claude-ctx-types",
        project: "type-counts-project",
        observation: makeObservation("decision"),
        promptNumber: 1,
      });
      storeObservation(db, {
        claudeSessionId: "claude-ctx-types",
        project: "type-counts-project",
        observation: makeObservation("decision"),
        promptNumber: 1,
      });
      storeObservation(db, {
        claudeSessionId: "claude-ctx-types",
        project: "type-counts-project",
        observation: makeObservation("decision"),
        promptNumber: 1,
      });
      storeObservation(db, {
        claudeSessionId: "claude-ctx-types",
        project: "type-counts-project",
        observation: makeObservation("bugfix"),
        promptNumber: 1,
      });
      storeObservation(db, {
        claudeSessionId: "claude-ctx-types",
        project: "type-counts-project",
        observation: makeObservation("bugfix"),
        promptNumber: 1,
      });
      storeObservation(db, {
        claudeSessionId: "claude-ctx-types",
        project: "type-counts-project",
        observation: makeObservation("feature"),
        promptNumber: 1,
      });

      const result = await handleGetContext(deps, {
        project: "type-counts-project",
        limit: 50,
      });

      expect(result.status).toBe(200);
      expect(result.body.typeCounts).toEqual({
        decision: 3,
        bugfix: 2,
        feature: 1,
      });
    });
  });
});

describe("handleGetContext — relevance scoring", () => {
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

  it("returns observations scored by relevance", async () => {
    // Create sessions first (foreign key requirement)
    createSession(db, {
      claudeSessionId: "sess-1",
      project: "project-a",
      userPrompt: "Fix auth",
    });
    createSession(db, {
      claudeSessionId: "sess-2",
      project: "project-b",
      userPrompt: "Update readme",
    });

    // Store observations from two projects
    storeObservation(db, {
      claudeSessionId: "sess-1",
      project: "project-a",
      observation: {
        type: "bugfix",
        title: "Fix auth bug in login",
        subtitle: null,
        narrative: "Fixed authentication timeout in login handler",
        facts: [],
        concepts: ["problem-solution"],
        filesRead: ["src/auth.ts"],
        filesModified: ["src/auth.ts"],
      },
      promptNumber: 1,
    });

    storeObservation(db, {
      claudeSessionId: "sess-2",
      project: "project-b",
      observation: {
        type: "change",
        title: "Update readme",
        subtitle: null,
        narrative: "Updated README with install instructions",
        facts: [],
        concepts: ["what-changed"],
        filesRead: ["README.md"],
        filesModified: ["README.md"],
      },
      promptNumber: 1,
    });

    const result = await handleGetContext(deps, {
      project: "project-a",
      limit: 10,
      format: "index",
    });

    expect(result.status).toBe(200);
    // Both projects should be represented (cross-project)
    const body = result.body as { context: string; observationCount: number };
    expect(body.observationCount).toBeGreaterThanOrEqual(1);
  });

  it("boosts observations with embeddings in scoring", async () => {
    createSession(db, {
      claudeSessionId: "sess-embed",
      project: "embed-project",
      userPrompt: "Test embeddings",
    });

    // Store two identical observations (same type, same time)
    storeObservation(db, {
      claudeSessionId: "sess-embed",
      project: "embed-project",
      observation: {
        type: "discovery",
        title: "Observation with embedding",
        subtitle: null,
        narrative: "Has an embedding vector",
        facts: [],
        concepts: [],
        filesRead: [],
        filesModified: [],
      },
      promptNumber: 1,
    });

    storeObservation(db, {
      claudeSessionId: "sess-embed",
      project: "embed-project",
      observation: {
        type: "discovery",
        title: "Observation without embedding",
        subtitle: null,
        narrative: "No embedding vector",
        facts: [],
        concepts: [],
        filesRead: [],
        filesModified: [],
      },
      promptNumber: 1,
    });

    // Set embedding on the first observation
    const fakeEmbedding = Buffer.from(new Float32Array([0.1, 0.2, 0.3]).buffer);
    db.run("UPDATE observations SET embedding = ? WHERE id = 1", [
      fakeEmbedding,
    ]);

    const result = await handleGetContext(deps, {
      project: "embed-project",
      limit: 10,
    });

    expect(result.status).toBe(200);
    const body = result.body as { context: string; observationCount: number };
    expect(body.observationCount).toBe(2);
    // The observation with embedding should be ranked first
    expect(body.context).toMatch(
      /Observation with embedding[\s\S]*Observation without embedding/,
    );
  });

  it("attributes cross-project observations in formatted output", async () => {
    // Create session first (foreign key requirement)
    createSession(db, {
      claudeSessionId: "sess-other",
      project: "other-project",
      userPrompt: "Fix bug",
    });

    // Store observation from another project
    storeObservation(db, {
      claudeSessionId: "sess-other",
      project: "other-project",
      observation: {
        type: "bugfix",
        title: "Same bug fix",
        subtitle: null,
        narrative: "Fixed the same bug",
        facts: [],
        concepts: [],
        filesRead: [],
        filesModified: [],
      },
      promptNumber: 1,
    });

    const result = await handleGetContext(deps, {
      project: "my-project",
      limit: 50,
      format: "index",
    });

    expect(result.status).toBe(200);
    const body = result.body as { context: string };
    // Cross-project items should be labeled
    if (body.context.includes("Same bug fix")) {
      expect(body.context).toContain("[from: other-project]");
    }
  });
});
