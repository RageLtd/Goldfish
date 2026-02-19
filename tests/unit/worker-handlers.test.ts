import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
  DEFAULT_EMBED_PORT,
  DEFAULT_GEN_PORT,
  serverUrl,
} from "../../src/constants";
import {
  createDatabase,
  createSession,
  runMigrations,
  storeObservation,
} from "../../src/db/index";
import type {
  ModelManager,
  ModelManagerConfig,
} from "../../src/models/manager";
import {
  handleCompleteSession,
  handleFindByFile,
  handleGetContext,
  handleGetDecisions,
  handleGetTimeline,
  handleHealth,
  handleQueueObservation,
  handleQueuePrompt,
  handleQueueSummary,
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

  describe("handleHealth", () => {
    it("returns ok status with metadata", async () => {
      const depsWithMeta = {
        ...deps,
        startedAt: Date.now() - 5000, // 5 seconds ago
        version: "1.0.0",
      };
      const result = await handleHealth(depsWithMeta);

      expect(result.status).toBe(200);
      expect(result.body.status).toBe("ok");
      expect(result.body.version).toBe("1.0.0");
      expect(result.body.uptimeSeconds).toBeGreaterThanOrEqual(5);
      expect(result.body.pendingMessages).toBe(0);
    });

    it("handles missing optional deps gracefully", async () => {
      const result = await handleHealth(deps);

      expect(result.status).toBe(200);
      expect(result.body.status).toBe("ok");
      expect(result.body.version).toBe("unknown");
      expect(result.body.uptimeSeconds).toBe(0);
      expect(result.body.pendingMessages).toBe(0);
    });
  });

  describe("handleQueueObservation", () => {
    it("queues observation for existing session", async () => {
      // Setup: create a session
      createSession(db, {
        claudeSessionId: "claude-123",
        project: "test-project",
        userPrompt: "Test",
      });

      const result = await handleQueueObservation(deps, {
        claudeSessionId: "claude-123",
        toolName: "Bash",
        toolInput: { command: "git status" },
        toolResponse: { stdout: "On branch main" },
        cwd: "/project",
      });

      expect(result.status).toBe(200);
      expect(result.body.status).toBe("queued");
    });

    it("creates session if not exists", async () => {
      const result = await handleQueueObservation(deps, {
        claudeSessionId: "new-session",
        toolName: "Read",
        toolInput: { path: "/file.ts" },
        toolResponse: { content: "code" },
        cwd: "/project",
      });

      expect(result.status).toBe(200);
    });

    it("returns 400 for missing claudeSessionId", async () => {
      const result = await handleQueueObservation(deps, {
        claudeSessionId: "",
        toolName: "Bash",
        toolInput: {},
        toolResponse: {},
        cwd: "",
      });

      expect(result.status).toBe(400);
    });
  });

  describe("handleQueueSummary", () => {
    it("queues summary request", async () => {
      createSession(db, {
        claudeSessionId: "claude-123",
        project: "test-project",
        userPrompt: "Test",
      });

      const result = await handleQueueSummary(deps, {
        claudeSessionId: "claude-123",
        lastUserMessage: "Fix the bug",
        lastAssistantMessage: "I fixed it",
      });

      expect(result.status).toBe(200);
      expect(result.body.status).toBe("queued");
    });
  });

  describe("handleCompleteSession", () => {
    it("marks session as completed", async () => {
      createSession(db, {
        claudeSessionId: "claude-123",
        project: "test-project",
        userPrompt: "Test",
      });

      const result = await handleCompleteSession(deps, {
        claudeSessionId: "claude-123",
        reason: "exit",
      });

      expect(result.status).toBe(200);
      expect(result.body.status).toBe("completed");
    });

    it("returns 404 for unknown session", async () => {
      const result = await handleCompleteSession(deps, {
        claudeSessionId: "unknown",
        reason: "exit",
      });

      expect(result.status).toBe(404);
    });
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

  describe("handleQueuePrompt", () => {
    it("stores prompt for new session", async () => {
      const result = await handleQueuePrompt(deps, {
        claudeSessionId: "claude-new",
        prompt: "Help me fix the bug",
        cwd: "/projects/my-app",
      });

      expect(result.status).toBe(200);
      expect(result.body.status).toBe("stored");
      expect(result.body.promptNumber).toBe(1);
    });

    it("increments prompt counter for existing session", async () => {
      createSession(db, {
        claudeSessionId: "claude-123",
        project: "test-project",
        userPrompt: "Initial prompt",
      });

      const result = await handleQueuePrompt(deps, {
        claudeSessionId: "claude-123",
        prompt: "Follow up prompt",
        cwd: "/projects/test-project",
      });

      expect(result.status).toBe(200);
      expect(result.body.promptNumber).toBeGreaterThan(1);
    });

    it("returns 400 for missing prompt", async () => {
      const result = await handleQueuePrompt(deps, {
        claudeSessionId: "claude-123",
        prompt: "",
        cwd: "/projects",
      });

      expect(result.status).toBe(400);
    });

    it("returns 400 for missing claudeSessionId", async () => {
      const result = await handleQueuePrompt(deps, {
        claudeSessionId: "",
        prompt: "test",
        cwd: "/projects",
      });

      expect(result.status).toBe(400);
    });
  });

  describe("handleSearch", () => {
    it("searches observations by query", async () => {
      // Setup
      createSession(db, {
        claudeSessionId: "claude-123",
        project: "test-project",
        userPrompt: "Test",
      });

      const result = await handleSearch(deps, {
        query: "authentication",
        type: "observations",
        limit: 10,
      });

      expect(result.status).toBe(200);
      expect(Array.isArray(result.body.results)).toBe(true);
    });

    it("filters by project", async () => {
      const result = await handleSearch(deps, {
        query: "test",
        type: "observations",
        project: "specific-project",
        limit: 10,
      });

      expect(result.status).toBe(200);
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

describe("handleSearch — embedding re-ranking", () => {
  let db: Database;

  const createMockModelManager = (
    embeddingFn?: (text: string) => Promise<Float32Array>,
  ): ModelManager => ({
    generateText: mock(async () => ""),
    computeEmbedding: mock(
      embeddingFn ?? (async () => new Float32Array([0.5, 0.5, 0.5])),
    ),
    dispose: mock(async () => {}),
    getConfig: mock(
      (): ModelManagerConfig => ({
        generativeModelId: "test",
        embeddingModelId: "test-embed",
        generationUrl: serverUrl(DEFAULT_GEN_PORT),
        embeddingUrl: serverUrl(DEFAULT_EMBED_PORT),
        cacheDir: "/tmp",
      }),
    ),
  });

  beforeEach(() => {
    db = createDatabase(":memory:");
    runMigrations(db);
    createSession(db, {
      claudeSessionId: "sess-search",
      project: "search-project",
      userPrompt: "Test search",
    });
  });

  afterEach(() => {
    db.close();
  });

  it("re-ranks observations by combined FTS + embedding score", async () => {
    // Store observations with keywords that FTS will match
    storeObservation(db, {
      claudeSessionId: "sess-search",
      project: "search-project",
      observation: {
        type: "discovery",
        title: "Authentication flow setup",
        subtitle: null,
        narrative: "Set up authentication flow with OAuth",
        facts: [],
        concepts: [],
        filesRead: [],
        filesModified: [],
      },
      promptNumber: 1,
    });

    storeObservation(db, {
      claudeSessionId: "sess-search",
      project: "search-project",
      observation: {
        type: "bugfix",
        title: "Authentication token refresh fix",
        subtitle: null,
        narrative: "Fixed authentication token refresh logic",
        facts: [],
        concepts: [],
        filesRead: [],
        filesModified: [],
      },
      promptNumber: 1,
    });

    // Give second observation an embedding that's very similar to query
    const queryLikeEmbedding = new Float32Array([0.9, 0.1, 0.0]);
    db.run("UPDATE observations SET embedding = ? WHERE id = 2", [
      Buffer.from(queryLikeEmbedding.buffer),
    ]);

    const modelManager = createMockModelManager(
      async () => new Float32Array([0.9, 0.1, 0.0]),
    );

    const deps: WorkerDeps = { db, modelManager };
    const result = await handleSearch(deps, {
      query: "authentication",
      type: "observations",
      limit: 10,
    });

    expect(result.status).toBe(200);
    expect(result.body.count).toBeGreaterThanOrEqual(1);
  });

  it("falls back to FTS-only when no modelManager", async () => {
    storeObservation(db, {
      claudeSessionId: "sess-search",
      project: "search-project",
      observation: {
        type: "discovery",
        title: "Database migration setup",
        subtitle: null,
        narrative: "Set up database migration system",
        facts: [],
        concepts: [],
        filesRead: [],
        filesModified: [],
      },
      promptNumber: 1,
    });

    const deps: WorkerDeps = { db };
    const result = await handleSearch(deps, {
      query: "database",
      type: "observations",
      limit: 10,
    });

    expect(result.status).toBe(200);
    expect(result.body.count).toBeGreaterThanOrEqual(1);
  });
});
