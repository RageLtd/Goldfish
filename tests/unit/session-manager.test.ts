/**
 * Tests for SessionManager - in-memory session state and message queues.
 */

import { describe, expect, it } from "bun:test";
import {
	createSessionManager,
	type PendingMessage,
} from "../../src/worker/session-manager";

describe("SessionManager", () => {
	describe("initializeSession", () => {
		it("creates a new session", () => {
			const manager = createSessionManager();
			const session = manager.initializeSession(
				1,
				"claude-123",
				"project-a",
				"test prompt",
			);

			expect(session.sessionDbId).toBe(1);
			expect(session.claudeSessionId).toBe("claude-123");
			expect(session.project).toBe("project-a");
			expect(session.userPrompt).toBe("test prompt");
			expect(session.abortController).toBeDefined();
		});

		it("returns existing session if already initialized", () => {
			const manager = createSessionManager();
			const session1 = manager.initializeSession(
				1,
				"claude-123",
				"project-a",
				"test prompt",
			);
			const session2 = manager.initializeSession(
				1,
				"different",
				"different",
				"different",
			);

			expect(session1).toBe(session2);
			expect(session2.claudeSessionId).toBe("claude-123");
		});
	});

	describe("getSession", () => {
		it("returns null for non-existent session", () => {
			const manager = createSessionManager();
			expect(manager.getSession(999)).toBeNull();
		});

		it("returns existing session", () => {
			const manager = createSessionManager();
			const created = manager.initializeSession(
				1,
				"claude-123",
				"project",
				"prompt",
			);
			const retrieved = manager.getSession(1);

			expect(retrieved).toBe(created);
		});
	});

	describe("queueObservation", () => {
		it("returns false for non-existent session", () => {
			const manager = createSessionManager();
			const result = manager.queueObservation(999, {
				toolName: "Read",
				toolInput: {},
				toolResponse: {},
				cwd: "/test",
				occurredAt: new Date().toISOString(),
			});

			expect(result).toBe(false);
		});

		it("queues observation for existing session", () => {
			const manager = createSessionManager();
			manager.initializeSession(1, "claude-123", "project", "prompt");

			const result = manager.queueObservation(1, {
				toolName: "Read",
				toolInput: { file: "test.ts" },
				toolResponse: { content: "..." },
				cwd: "/test",
				occurredAt: new Date().toISOString(),
			});

			expect(result).toBe(true);
		});
	});

	describe("queueSummarize", () => {
		it("returns false for non-existent session", () => {
			const manager = createSessionManager();
			const result = manager.queueSummarize(999, "last message");

			expect(result).toBe(false);
		});

		it("queues summarize request for existing session", () => {
			const manager = createSessionManager();
			manager.initializeSession(1, "claude-123", "project", "prompt");

			const result = manager.queueSummarize(
				1,
				"last user message",
				"last assistant",
			);

			expect(result).toBe(true);
		});
	});

	describe("queueContinuation", () => {
		it("returns false for non-existent session", () => {
			const manager = createSessionManager();
			const result = manager.queueContinuation(999, "new prompt", 2);

			expect(result).toBe(false);
		});

		it("queues continuation for existing session", () => {
			const manager = createSessionManager();
			manager.initializeSession(1, "claude-123", "project", "prompt");

			const result = manager.queueContinuation(1, "follow up prompt", 2);

			expect(result).toBe(true);
		});
	});

	describe("getMessageIterator", () => {
		it("returns null for non-existent session", () => {
			const manager = createSessionManager();
			expect(manager.getMessageIterator(999)).toBeNull();
		});

		it("returns iterator for existing session", () => {
			const manager = createSessionManager();
			manager.initializeSession(1, "claude-123", "project", "prompt");

			const iterator = manager.getMessageIterator(1);

			expect(iterator).not.toBeNull();
			expect(typeof iterator?.[Symbol.asyncIterator]).toBe("function");
		});

		it("yields queued messages in order", async () => {
			const manager = createSessionManager();
			manager.initializeSession(1, "claude-123", "project", "prompt");

			// Queue messages first
			manager.queueObservation(1, {
				toolName: "Read",
				toolInput: {},
				toolResponse: {},
				cwd: "/test",
				occurredAt: "2024-01-01T00:00:00Z",
			});
			manager.queueSummarize(1, "last message");

			const iterator = manager.getMessageIterator(1);
			expect(iterator).not.toBeNull();
			const messages: PendingMessage[] = [];

			// Get first message
			const result1 = await iterator?.next();
			if (result1 && !result1.done) messages.push(result1.value);

			// Get second message
			const result2 = await iterator?.next();
			if (result2 && !result2.done) messages.push(result2.value);

			expect(messages.length).toBe(2);
			expect(messages[0].type).toBe("observation");
			expect(messages[1].type).toBe("summarize");
		});

		it("resolves immediately when messages are queued after waiting", async () => {
			const manager = createSessionManager();
			manager.initializeSession(1, "claude-123", "project", "prompt");

			const iterator = manager.getMessageIterator(1);
			expect(iterator).not.toBeNull();

			// Start waiting for a message
			const pendingPromise = iterator?.next();

			// Queue a message while waiting
			manager.queueObservation(1, {
				toolName: "Write",
				toolInput: {},
				toolResponse: {},
				cwd: "/test",
				occurredAt: "2024-01-01T00:00:00Z",
			});

			// Should resolve with the queued message
			const result = await pendingPromise;
			expect(result.done).toBe(false);
			expect(result.value.type).toBe("observation");
		});
	});

	describe("closeSession", () => {
		it("returns false for non-existent session", () => {
			const manager = createSessionManager();
			expect(manager.closeSession(999)).toBe(false);
		});

		it("closes existing session and aborts controller", () => {
			const manager = createSessionManager();
			const session = manager.initializeSession(
				1,
				"claude-123",
				"project",
				"prompt",
			);

			const result = manager.closeSession(1);

			expect(result).toBe(true);
			expect(session.abortController.signal.aborted).toBe(true);
			expect(manager.getSession(1)).toBeNull();
		});

		it("returns false for queueing after close", () => {
			const manager = createSessionManager();
			manager.initializeSession(1, "claude-123", "project", "prompt");
			manager.closeSession(1);

			const result = manager.queueObservation(1, {
				toolName: "Read",
				toolInput: {},
				toolResponse: {},
				cwd: "/test",
				occurredAt: "2024-01-01T00:00:00Z",
			});

			expect(result).toBe(false);
		});

		it("terminates waiting iterators on close", async () => {
			const manager = createSessionManager();
			manager.initializeSession(1, "claude-123", "project", "prompt");

			const iterator = manager.getMessageIterator(1);
			expect(iterator).not.toBeNull();
			const pendingPromise = iterator?.next();

			// Close while waiting
			manager.closeSession(1);

			const result = await pendingPromise;
			expect(result.done).toBe(true);
		});
	});

	describe("getActiveSessions", () => {
		it("returns empty array when no sessions", () => {
			const manager = createSessionManager();
			expect(manager.getActiveSessions()).toEqual([]);
		});

		it("returns all active sessions", () => {
			const manager = createSessionManager();
			manager.initializeSession(1, "claude-1", "project-a", "prompt-1");
			manager.initializeSession(2, "claude-2", "project-b", "prompt-2");

			const sessions = manager.getActiveSessions();

			expect(sessions.length).toBe(2);
			expect(sessions.map((s) => s.claudeSessionId)).toContain("claude-1");
			expect(sessions.map((s) => s.claudeSessionId)).toContain("claude-2");
		});

		it("excludes closed sessions", () => {
			const manager = createSessionManager();
			manager.initializeSession(1, "claude-1", "project-a", "prompt-1");
			manager.initializeSession(2, "claude-2", "project-b", "prompt-2");
			manager.closeSession(1);

			const sessions = manager.getActiveSessions();

			expect(sessions.length).toBe(1);
			expect(sessions[0].claudeSessionId).toBe("claude-2");
		});
	});
});
