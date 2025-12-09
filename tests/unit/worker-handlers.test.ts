import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	createDatabase,
	createSession,
	runMigrations,
} from "../../src/db/index";
import {
	handleCompleteSession,
	handleGetContext,
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
