import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  createDatabase,
  createSession,
  runMigrations,
} from "../../src/db/index";
import {
  handleCompleteSession,
  handleHealth,
  handleQueueObservation,
  handleQueueSummary,
  handleShutdown,
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

  describe("handleShutdown", () => {
    it("returns shutting_down status and calls callback", async () => {
      let called = false;
      const onShutdown = () => {
        called = true;
      };

      const result = await handleShutdown(deps, onShutdown);

      expect(result.status).toBe(200);
      expect(result.body.status).toBe("shutting_down");
      // Callback is scheduled via setTimeout, wait for it
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(called).toBe(true);
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
});
