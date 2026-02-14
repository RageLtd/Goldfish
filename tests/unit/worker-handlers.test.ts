import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  createDatabase,
  createSession,
  runMigrations,
  storeObservation,
} from "../../src/db/index";
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
import {
  createSessionManager,
  type SessionManager,
} from "../../src/worker/session-manager";

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
      expect(result.body.activeSessions).toBe(0);
    });

    it("handles missing optional deps gracefully", async () => {
      const result = await handleHealth(deps);

      expect(result.status).toBe(200);
      expect(result.body.status).toBe("ok");
      expect(result.body.version).toBe("unknown");
      expect(result.body.uptimeSeconds).toBe(0);
      expect(result.body.activeSessions).toBe(0);
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

describe("worker handlers with SessionManager integration", () => {
  let db: Database;
  let sessionManager: SessionManager;
  let deps: WorkerDeps;

  beforeEach(() => {
    db = createDatabase(":memory:");
    runMigrations(db);
    sessionManager = createSessionManager();
    deps = { db, sessionManager };
  });

  afterEach(() => {
    db.close();
  });

  describe("handleQueuePrompt with SessionManager", () => {
    it("initializes session in SessionManager for new session", async () => {
      const result = await handleQueuePrompt(deps, {
        claudeSessionId: "claude-new",
        prompt: "Help me fix a bug",
        cwd: "/projects/my-app",
      });

      expect(result.status).toBe(200);
      // SessionManager should have initialized the session
      const activeSessions = sessionManager.getActiveSessions();
      expect(activeSessions.length).toBe(1);
      expect(activeSessions[0].claudeSessionId).toBe("claude-new");
      expect(activeSessions[0].userPrompt).toBe("Help me fix a bug");
    });

    it("queues continuation in SessionManager for existing session", async () => {
      // First create session
      createSession(db, {
        claudeSessionId: "claude-123",
        project: "test-project",
        userPrompt: "Initial prompt",
      });

      // Initialize in SessionManager manually (simulating prior prompt)
      sessionManager.initializeSession(
        1,
        "claude-123",
        "test-project",
        "Initial prompt",
      );

      const result = await handleQueuePrompt(deps, {
        claudeSessionId: "claude-123",
        prompt: "Follow up prompt",
        cwd: "/projects/test-project",
      });

      expect(result.status).toBe(200);
      expect(result.body.promptNumber).toBeGreaterThan(1);

      // Should have queued a continuation message
      const iterator = sessionManager.getMessageIterator(1);
      expect(iterator).not.toBeNull();
      const msg = await iterator?.next();
      expect(msg?.value?.type).toBe("continuation");
    });
  });

  describe("handleQueueObservation with SessionManager", () => {
    it("queues observation in SessionManager for active session", async () => {
      // Create session in DB
      createSession(db, {
        claudeSessionId: "claude-123",
        project: "test-project",
        userPrompt: "Test",
      });

      // Initialize in SessionManager
      sessionManager.initializeSession(1, "claude-123", "test-project", "Test");

      const result = await handleQueueObservation(deps, {
        claudeSessionId: "claude-123",
        toolName: "Bash",
        toolInput: { command: "git status" },
        toolResponse: { stdout: "On branch main" },
        cwd: "/project",
      });

      expect(result.status).toBe(200);

      // Should have queued an observation message
      const iterator = sessionManager.getMessageIterator(1);
      expect(iterator).not.toBeNull();
      const msg = await iterator?.next();
      expect(msg?.value?.type).toBe("observation");
    });
  });

  describe("handleQueueSummary with SessionManager", () => {
    it("queues summarize in SessionManager for active session", async () => {
      createSession(db, {
        claudeSessionId: "claude-123",
        project: "test-project",
        userPrompt: "Test",
      });

      sessionManager.initializeSession(1, "claude-123", "test-project", "Test");

      const result = await handleQueueSummary(deps, {
        claudeSessionId: "claude-123",
        lastUserMessage: "Fix the bug",
        lastAssistantMessage: "I fixed it",
      });

      expect(result.status).toBe(200);

      // Should have queued a summarize message
      const iterator = sessionManager.getMessageIterator(1);
      expect(iterator).not.toBeNull();
      const msg = await iterator?.next();
      expect(msg?.value?.type).toBe("summarize");
    });
  });

  describe("handleCompleteSession with SessionManager", () => {
    it("closes session in SessionManager", async () => {
      createSession(db, {
        claudeSessionId: "claude-123",
        project: "test-project",
        userPrompt: "Test",
      });

      sessionManager.initializeSession(1, "claude-123", "test-project", "Test");

      expect(sessionManager.getActiveSessions().length).toBe(1);

      const result = await handleCompleteSession(deps, {
        claudeSessionId: "claude-123",
        reason: "exit",
      });

      expect(result.status).toBe(200);
      expect(sessionManager.getActiveSessions().length).toBe(0);
    });
  });
});
