import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
  DEFAULT_EMBED_PORT,
  DEFAULT_GEN_PORT,
  serverUrl,
} from "../../src/constants";
import {
  createSession,
  runMigrations,
  storeObservation,
  updateObservationEmbedding,
} from "../../src/db/index";
import { createGraphManager } from "../../src/graph/index";
import type { ModelManager } from "../../src/models/manager";
import {
  handleBackfill,
  handleBackfillStatus,
  handleRetrieve,
  type RetrieveInput,
  type WorkerDeps,
} from "../../src/worker/handlers";
import {
  createMessageRouter,
  type RouterMessage,
} from "../../src/worker/message-router";

describe("handleRetrieve", () => {
  let db: Database;
  let deps: WorkerDeps;
  let mockModelManager: ModelManager;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);

    mockModelManager = {
      getConfig: () => ({
        generativeModelId: "test",
        embeddingModelId: "test",
        generationUrl: serverUrl(DEFAULT_GEN_PORT),
        embeddingUrl: serverUrl(DEFAULT_EMBED_PORT),
        cacheDir: "",
      }),
      generateText: mock(() =>
        Promise.resolve(
          '<tool_call>\n{"name": "search_memory_semantic", "arguments": {"query": "auth bug fix"}}\n</tool_call>',
        ),
      ),
      computeEmbedding: mock(() =>
        Promise.resolve(new Float32Array([0.1, 0.2, 0.3])),
      ),
      dispose: mock(() => Promise.resolve()),
    };

    deps = {
      db,
      modelManager: mockModelManager,
      graphManager: createGraphManager(),
    };
  });

  afterEach(() => {
    db.close();
  });

  it("returns 400 when prompt is empty", async () => {
    const input: RetrieveInput = { prompt: "", project: "test", limit: 20 };
    const result = await handleRetrieve(deps, input);
    expect(result.status).toBe(400);
  });

  it("returns 503 when ModelManager is unavailable", async () => {
    const depsNoModel: WorkerDeps = { db };
    const input: RetrieveInput = {
      prompt: "Fix the auth bug",
      project: "test",
      limit: 20,
    };
    const result = await handleRetrieve(depsNoModel, input);
    expect(result.status).toBe(503);
  });

  it("returns no context when model returns no tool call", async () => {
    (
      mockModelManager.generateText as ReturnType<typeof mock>
    ).mockImplementation(() =>
      Promise.resolve("This is just a greeting, no search needed."),
    );

    const input: RetrieveInput = {
      prompt: "Hello there!",
      project: "test",
      limit: 20,
    };
    const result = await handleRetrieve(deps, input);
    expect(result.status).toBe(200);
    expect((result.body as { context: unknown }).context).toBeNull();
    expect((result.body as { observationCount: number }).observationCount).toBe(
      0,
    );
  });

  it("returns 500 when model generation fails", async () => {
    (
      mockModelManager.generateText as ReturnType<typeof mock>
    ).mockImplementation(() => Promise.reject(new Error("Model crashed")));

    const input: RetrieveInput = {
      prompt: "Fix the auth bug",
      project: "test",
      limit: 20,
    };
    const result = await handleRetrieve(deps, input);
    expect(result.status).toBe(500);
    expect((result.body as { error: string }).error).toContain(
      "Model generation failed",
    );
  });

  it("returns formatted context when observations match", async () => {
    // Seed the DB with a matching observation
    createSession(db, {
      claudeSessionId: "session-1",
      project: "test",
      userPrompt: "test prompt",
    });

    const obsResult = storeObservation(db, {
      claudeSessionId: "session-1",
      project: "test",
      promptNumber: 1,
      discoveryTokens: 100,
      observation: {
        type: "bugfix",
        title: "Fixed auth token refresh bug",
        subtitle: "Token was not refreshing",
        narrative: "The auth token refresh was failing due to missing await",
        facts: [],
        concepts: [],
        filesRead: [],
        filesModified: ["src/auth.ts"],
      },
    });

    // Store embedding so semantic search can find it
    if (obsResult.ok) {
      updateObservationEmbedding(
        db,
        obsResult.value,
        new Float32Array([0.1, 0.2, 0.3]),
      );
    }

    // Model extracts "auth token refresh" as search query
    (
      mockModelManager.generateText as ReturnType<typeof mock>
    ).mockImplementation(() =>
      Promise.resolve(
        '<tool_call>\n{"name": "search_memory_semantic", "arguments": {"query": "auth token refresh"}}\n</tool_call>',
      ),
    );

    const input: RetrieveInput = {
      prompt: "I need to fix the authentication token refresh issue",
      project: "test",
      limit: 20,
    };
    const result = await handleRetrieve(deps, input);
    expect(result.status).toBe(200);

    const body = result.body as {
      context: string;
      observationCount: number;
      typeCounts: Record<string, number>;
    };
    expect(body.observationCount).toBeGreaterThan(0);
    expect(body.context).toContain("auth");
    expect(body.typeCounts.bugfix).toBeGreaterThan(0);
  });

  it("returns no context when search finds no matches", async () => {
    const input: RetrieveInput = {
      prompt: "Implement a completely new feature",
      project: "test",
      limit: 20,
    };
    const result = await handleRetrieve(deps, input);
    expect(result.status).toBe(200);

    const body = result.body as { context: unknown; observationCount: number };
    expect(body.context).toBeNull();
    expect(body.observationCount).toBe(0);
  });
});

describe("handleBackfill", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  it("returns enqueued: 0 when no observations lack embeddings", async () => {
    const enqueued: RouterMessage[] = [];
    const router = createMessageRouter({
      processMessage: async () => {},
    });
    const originalEnqueue = router.enqueue;
    router.enqueue = (msg: RouterMessage) => {
      enqueued.push(msg);
      originalEnqueue(msg);
    };

    const result = await handleBackfill({ db, router });
    expect(result.status).toBe(200);
    expect((result.body as { enqueued: number }).enqueued).toBe(0);
  });

  it("enqueues embed messages for observations without embeddings", async () => {
    createSession(db, {
      claudeSessionId: "bf-session",
      project: "test",
      userPrompt: "test",
    });

    storeObservation(db, {
      claudeSessionId: "bf-session",
      project: "test",
      promptNumber: 1,
      discoveryTokens: 100,
      observation: {
        type: "discovery",
        title: "Test observation",
        subtitle: "sub",
        narrative: "narrative",
        facts: [],
        concepts: [],
        filesRead: [],
        filesModified: [],
      },
    });

    const enqueued: RouterMessage[] = [];
    const router = createMessageRouter({
      processMessage: async () => {},
    });
    const deps: WorkerDeps = { db, router };

    // Intercept enqueue calls
    const origEnqueue = router.enqueue.bind(router);
    (router as { enqueue: typeof origEnqueue }).enqueue = (
      msg: RouterMessage,
    ) => {
      enqueued.push(msg);
    };

    const result = await handleBackfill(deps);
    expect(result.status).toBe(200);
    expect((result.body as { enqueued: number }).enqueued).toBe(1);
    expect(enqueued.length).toBe(1);
    expect(enqueued[0].type).toBe("embed");
  });

  it("returns enqueued: 0 when router is unavailable", async () => {
    createSession(db, {
      claudeSessionId: "bf-session-2",
      project: "test",
      userPrompt: "test",
    });

    storeObservation(db, {
      claudeSessionId: "bf-session-2",
      project: "test",
      promptNumber: 1,
      discoveryTokens: 100,
      observation: {
        type: "discovery",
        title: "No router obs",
        subtitle: "sub",
        narrative: "narrative",
        facts: [],
        concepts: [],
        filesRead: [],
        filesModified: [],
      },
    });

    const result = await handleBackfill({ db });
    expect(result.status).toBe(200);
    expect((result.body as { enqueued: number }).enqueued).toBe(0);
  });
});

describe("handleBackfillStatus", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  it("returns remaining: 0 when all have embeddings", async () => {
    const result = await handleBackfillStatus({ db });
    expect(result.status).toBe(200);
    const body = result.body as { remaining: number; pendingMessages: number };
    expect(body.remaining).toBe(0);
    expect(body.pendingMessages).toBe(0);
  });

  it("returns correct remaining count", async () => {
    createSession(db, {
      claudeSessionId: "status-session",
      project: "test",
      userPrompt: "test",
    });

    storeObservation(db, {
      claudeSessionId: "status-session",
      project: "test",
      promptNumber: 1,
      discoveryTokens: 100,
      observation: {
        type: "discovery",
        title: "Needs embedding",
        subtitle: "sub",
        narrative: "narrative",
        facts: [],
        concepts: [],
        filesRead: [],
        filesModified: [],
      },
    });

    const result = await handleBackfillStatus({ db });
    expect(result.status).toBe(200);
    expect((result.body as { remaining: number }).remaining).toBe(1);
  });
});
