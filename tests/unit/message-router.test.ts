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
  getObservationById,
  runMigrations,
} from "../../src/db/index";
import type {
  ModelManager,
  ModelManagerConfig,
} from "../../src/models/manager";
import {
  createMessageRouter,
  createProcessMessage,
  type RouterMessage,
} from "../../src/worker/message-router";

const makeMsg = (id: string): RouterMessage => ({
  type: "observation",
  claudeSessionId: id,
  data: { toolName: "Edit", toolInput: {}, toolResponse: "", cwd: "/tmp" },
});

describe("message-router", () => {
  it("processes enqueued messages in FIFO order", async () => {
    const processed: string[] = [];
    const processor = mock(async (msg: RouterMessage) => {
      processed.push(msg.claudeSessionId);
    });

    const router = createMessageRouter({ processMessage: processor });

    router.enqueue(makeMsg("a"));
    router.enqueue(makeMsg("b"));

    await router.shutdown();

    expect(processed).toEqual(["a", "b"]);
    expect(processor).toHaveBeenCalledTimes(2);
  });

  it("processes messages sequentially (not in parallel)", async () => {
    const timeline: string[] = [];
    const processor = mock(async (msg: RouterMessage) => {
      timeline.push(`start-${msg.claudeSessionId}`);
      await new Promise((r) => setTimeout(r, 10));
      timeline.push(`end-${msg.claudeSessionId}`);
    });

    const router = createMessageRouter({ processMessage: processor });

    router.enqueue(makeMsg("first"));
    router.enqueue(makeMsg("second"));

    await router.shutdown();

    expect(timeline).toEqual([
      "start-first",
      "end-first",
      "start-second",
      "end-second",
    ]);
  });

  it("shutdown resolves immediately when queue is empty", async () => {
    const processor = mock(async () => {});
    const router = createMessageRouter({ processMessage: processor });

    await router.shutdown();

    expect(processor).not.toHaveBeenCalled();
  });

  it("reports pending count", async () => {
    let resolveFirst!: () => void;
    const blockingPromise = new Promise<void>((r) => {
      resolveFirst = r;
    });
    const processor = mock(async () => {
      await blockingPromise;
    });

    const router = createMessageRouter({ processMessage: processor });

    router.enqueue(makeMsg("a"));
    router.enqueue(makeMsg("b"));

    // First message is being processed, second is pending
    expect(router.pending()).toBe(1);

    resolveFirst();
    await router.shutdown();

    expect(router.pending()).toBe(0);
  });

  it("continues processing after a message handler throws", async () => {
    const processed: string[] = [];
    let callCount = 0;
    const processor = mock(async (msg: RouterMessage) => {
      callCount++;
      if (callCount === 1) throw new Error("boom");
      processed.push(msg.claudeSessionId);
    });

    const router = createMessageRouter({ processMessage: processor });

    router.enqueue(makeMsg("fails"));
    router.enqueue(makeMsg("succeeds"));

    await router.shutdown();

    expect(processed).toEqual(["succeeds"]);
  });

  it("handles messages enqueued during processing", async () => {
    const processed: string[] = [];
    let enqueueMore: (() => void) | null = null;

    const processor = mock(async (msg: RouterMessage) => {
      processed.push(msg.claudeSessionId);
      if (enqueueMore) {
        const fn = enqueueMore;
        enqueueMore = null;
        fn();
      }
    });

    const router = createMessageRouter({ processMessage: processor });

    enqueueMore = () => {
      router.enqueue(makeMsg("dynamic"));
    };

    router.enqueue(makeMsg("initial"));

    await router.shutdown();

    expect(processed).toEqual(["initial", "dynamic"]);
  });
});

// ============================================================================
// Integration tests with createProcessMessage
// ============================================================================

const VALID_TOOL_CALL = `{"name": "create_observation", "arguments": {"type": "feature", "title": "Added user authentication", "subtitle": "OAuth2 flow implemented", "narrative": "Implemented OAuth2 PKCE flow for user authentication", "facts": ["Uses PKCE flow", "Supports refresh tokens"], "concepts": ["what-changed"]}}`;

const createMockModelManager = (
  overrides: { generateTextResponse?: string } = {},
): ModelManager => ({
  generateText: mock(
    async () => overrides.generateTextResponse ?? VALID_TOOL_CALL,
  ),
  computeEmbedding: mock(async () => new Float32Array([0.1, 0.2, 0.3])),
  dispose: mock(async () => {}),
  getConfig: mock(
    (): ModelManagerConfig => ({
      generativeModelId: "test-model",
      embeddingModelId: "test-embed-model",
      generationUrl: serverUrl(DEFAULT_GEN_PORT),
      embeddingUrl: serverUrl(DEFAULT_EMBED_PORT),
      cacheDir: "/tmp/test-models",
    }),
  ),
});

describe("message-router integration", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
    runMigrations(db);
    createSession(db, {
      claudeSessionId: "test-session-int",
      project: "test-project",
      userPrompt: "Build something",
    });
  });

  afterEach(() => {
    db.close();
  });

  it("processes observation message end-to-end", async () => {
    const modelManager = createMockModelManager();
    const processMessage = createProcessMessage({
      db,
      modelManager,
      enqueue: () => {},
    });
    const router = createMessageRouter({ processMessage });

    router.enqueue({
      type: "observation",
      claudeSessionId: "test-session-int",
      data: {
        toolName: "Edit",
        toolInput: { file_path: "/src/app.ts" },
        toolResponse: "File edited",
        cwd: "/test-project",
      },
    });

    await router.shutdown();

    const obs = getObservationById(db, 1);
    expect(obs.ok).toBe(true);
    if (obs.ok && obs.value) {
      expect(obs.value.title).toBe("Added user authentication");
    }
  });

  it("enqueues embed after successful observation and stores embedding", async () => {
    const modelManager = createMockModelManager();
    const processMessage = createProcessMessage({
      db,
      modelManager,
      enqueue: (msg) => router.enqueue(msg),
    });
    const router = createMessageRouter({ processMessage });

    router.enqueue({
      type: "observation",
      claudeSessionId: "test-session-int",
      data: {
        toolName: "Edit",
        toolInput: { file_path: "/src/app.ts" },
        toolResponse: "File edited",
        cwd: "/test-project",
      },
    });

    await router.shutdown();

    // Observation should be stored
    const obs = getObservationById(db, 1);
    expect(obs.ok).toBe(true);
    if (!obs.ok || !obs.value) throw new Error("observation not found");

    // Embedding should have been computed via the enqueued embed message
    const row = db
      .query<{ embedding: Buffer | null }, [number]>(
        "SELECT embedding FROM observations WHERE id = ?",
      )
      .get(1);
    expect(row?.embedding).not.toBeNull();

    // generateText for observation + computeEmbedding for embed
    expect(modelManager.generateText).toHaveBeenCalledTimes(1);
    expect(modelManager.computeEmbedding).toHaveBeenCalledTimes(1);
  });

  it("processes summarize message end-to-end", async () => {
    const summaryResponse = `{"name": "create_summary", "arguments": {"request": "Build something", "completed": "Built it"}}`;
    const modelManager = createMockModelManager({
      generateTextResponse: summaryResponse,
    });
    const processMessage = createProcessMessage({
      db,
      modelManager,
      enqueue: () => {},
    });
    const router = createMessageRouter({ processMessage });

    router.enqueue({
      type: "summarize",
      claudeSessionId: "test-session-int",
      data: {
        lastUserMessage: "Build something",
        lastAssistantMessage: "Done",
      },
    });

    await router.shutdown();

    const row = db
      .query<{ id: number }, [string]>(
        "SELECT id FROM session_summaries WHERE sdk_session_id = ?",
      )
      .get("test-session-int");
    expect(row).toBeDefined();
  });

  it("processes complete message by updating session status", async () => {
    const modelManager = createMockModelManager();
    const processMessage = createProcessMessage({
      db,
      modelManager,
      enqueue: () => {},
    });
    const router = createMessageRouter({ processMessage });

    router.enqueue({
      type: "complete",
      claudeSessionId: "test-session-int",
      data: { reason: "exit" },
    });

    await router.shutdown();

    const session = db
      .query<{ status: string }, [string]>(
        "SELECT status FROM sdk_sessions WHERE claude_session_id = ?",
      )
      .get("test-session-int");
    expect(session?.status).toBe("completed");
  });

  it("processes embed message by storing computed embedding", async () => {
    const modelManager = createMockModelManager();
    const processMessage = createProcessMessage({
      db,
      modelManager,
      enqueue: () => {},
    });
    const router = createMessageRouter({ processMessage });

    // Store an observation first so the embed can update it
    const obsResult = db.run(
      `INSERT INTO observations
       (sdk_session_id, project, type, title, narrative, facts, concepts,
        files_read, files_modified, prompt_number, discovery_tokens, created_at, created_at_epoch)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "test-session-int",
        "test-project",
        "discovery",
        "Test obs",
        "Narrative",
        "[]",
        "[]",
        "[]",
        "[]",
        1,
        0,
        new Date().toISOString(),
        Date.now(),
      ],
    );
    const obsId = Number(obsResult.lastInsertRowid);

    router.enqueue({
      type: "embed",
      claudeSessionId: "test-session-int",
      data: {
        observationId: obsId,
        title: "Test obs",
        narrative: "Narrative",
      },
    });

    await router.shutdown();

    // Verify embedding was stored
    const row = db
      .query<{ embedding: Buffer | null }, [number]>(
        "SELECT embedding FROM observations WHERE id = ?",
      )
      .get(obsId);
    expect(row?.embedding).not.toBeNull();
    expect(modelManager.computeEmbedding).toHaveBeenCalledTimes(1);
  });

  it("enqueues prune after first complete message", async () => {
    const modelManager = createMockModelManager();
    const enqueuedMessages: RouterMessage[] = [];
    const processMessage = createProcessMessage({
      db,
      modelManager,
      enqueue: (msg) => enqueuedMessages.push(msg),
    });
    const router = createMessageRouter({ processMessage });

    router.enqueue({
      type: "complete",
      claudeSessionId: "test-session-int",
      data: { reason: "exit" },
    });

    await router.shutdown();

    // Should have enqueued a prune message
    const pruneMessages = enqueuedMessages.filter((m) => m.type === "prune");
    expect(pruneMessages.length).toBe(1);
  });

  it("rate-limits prune to once per interval", async () => {
    const modelManager = createMockModelManager();
    const enqueuedMessages: RouterMessage[] = [];
    const processMessage = createProcessMessage({
      db,
      modelManager,
      enqueue: (msg) => enqueuedMessages.push(msg),
    });
    const router = createMessageRouter({ processMessage });

    // Two consecutive completes — second should NOT trigger prune
    router.enqueue({
      type: "complete",
      claudeSessionId: "test-session-int",
      data: { reason: "exit" },
    });
    router.enqueue({
      type: "complete",
      claudeSessionId: "test-session-int",
      data: { reason: "exit again" },
    });

    await router.shutdown();

    const pruneMessages = enqueuedMessages.filter((m) => m.type === "prune");
    expect(pruneMessages.length).toBe(1);
  });

  it("skips messages for unknown sessions", async () => {
    const modelManager = createMockModelManager();
    const processMessage = createProcessMessage({
      db,
      modelManager,
      enqueue: () => {},
    });
    const router = createMessageRouter({ processMessage });

    router.enqueue({
      type: "observation",
      claudeSessionId: "nonexistent-session",
      data: {
        toolName: "Edit",
        toolInput: {},
        toolResponse: "",
        cwd: "/tmp",
      },
    });

    await router.shutdown();

    // Should not throw, just skip
    expect(modelManager.generateText).not.toHaveBeenCalled();
  });
});
