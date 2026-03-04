import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  createDatabase,
  createSession,
  getSessionByClaudeId,
  incrementPromptCounter,
  runMigrations,
  updateSessionStatus,
} from "../../src/db/index";

describe("database sessions", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  describe("createSession", () => {
    it("creates a new session and returns id with isNew=true", () => {
      const result = createSession(db, {
        claudeSessionId: "claude-123",
        project: "test-project",
        userPrompt: "Help me with something",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.id).toBeGreaterThan(0);
        expect(result.value.isNew).toBe(true);
      }
    });

    it("is idempotent - returns existing session with isNew=false on duplicate", () => {
      const first = createSession(db, {
        claudeSessionId: "claude-123",
        project: "test-project",
        userPrompt: "First prompt",
      });

      const second = createSession(db, {
        claudeSessionId: "claude-123",
        project: "test-project",
        userPrompt: "Different prompt",
      });

      expect(first.ok && second.ok).toBe(true);
      if (first.ok && second.ok) {
        expect(first.value.id).toBe(second.value.id);
        expect(first.value.isNew).toBe(true);
        expect(second.value.isNew).toBe(false);
      }
    });
  });

  describe("getSessionByClaudeId", () => {
    it("returns session when it exists", () => {
      createSession(db, {
        claudeSessionId: "claude-456",
        project: "my-project",
        userPrompt: "Test",
      });

      const result = getSessionByClaudeId(db, "claude-456");
      expect(result.ok).toBe(true);
      if (result.ok && result.value) {
        expect(result.value.claudeSessionId).toBe("claude-456");
        expect(result.value.project).toBe("my-project");
        expect(result.value.status).toBe("active");
      }
    });

    it("returns null when session does not exist", () => {
      const result = getSessionByClaudeId(db, "nonexistent");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBeNull();
      }
    });
  });

  describe("updateSessionStatus", () => {
    it("updates session status", () => {
      const createResult = createSession(db, {
        claudeSessionId: "claude-789",
        project: "test",
        userPrompt: "Test",
      });

      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      updateSessionStatus(db, createResult.value.id, "completed");

      const result = getSessionByClaudeId(db, "claude-789");
      expect(result.ok).toBe(true);
      if (result.ok && result.value) {
        expect(result.value.status).toBe("completed");
      }
    });
  });

  describe("incrementPromptCounter", () => {
    it("increments and returns new counter value", () => {
      const createResult = createSession(db, {
        claudeSessionId: "claude-counter",
        project: "test",
        userPrompt: "Test",
      });

      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const result = incrementPromptCounter(db, createResult.value.id);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(2); // Starts at 1, incremented to 2
      }
    });
  });
});
