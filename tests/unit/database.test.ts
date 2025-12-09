import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	createDatabase,
	createSession,
	getObservationById,
	getRecentObservations,
	getSessionByClaudeId,
	incrementPromptCounter,
	runMigrations,
	saveUserPrompt,
	searchObservations,
	storeObservation,
	storeSummary,
	updateSessionStatus,
} from "../../src/db/index";
import type { ParsedObservation, ParsedSummary } from "../../src/types/domain";

describe("database", () => {
	let db: Database;

	beforeEach(() => {
		// Use in-memory database for tests
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
				userPrompt: "Second prompt",
			});

			expect(first.ok).toBe(true);
			expect(second.ok).toBe(true);
			if (first.ok && second.ok) {
				expect(first.value.id).toBe(second.value.id);
				expect(first.value.isNew).toBe(true);
				expect(second.value.isNew).toBe(false);
			}
		});
	});

	describe("getSessionByClaudeId", () => {
		it("returns session when found", () => {
			createSession(db, {
				claudeSessionId: "claude-123",
				project: "test-project",
				userPrompt: "Test prompt",
			});

			const result = getSessionByClaudeId(db, "claude-123");

			expect(result.ok).toBe(true);
			if (result.ok && result.value) {
				expect(result.value.claudeSessionId).toBe("claude-123");
				expect(result.value.project).toBe("test-project");
				expect(result.value.status).toBe("active");
			}
		});

		it("returns null when not found", () => {
			const result = getSessionByClaudeId(db, "nonexistent");

			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value).toBeNull();
			}
		});
	});

	describe("updateSessionStatus", () => {
		it("updates status to completed", () => {
			const createResult = createSession(db, {
				claudeSessionId: "claude-123",
				project: "test-project",
				userPrompt: "Test",
			});

			if (!createResult.ok) throw new Error("Setup failed");

			const updateResult = updateSessionStatus(
				db,
				createResult.value.id,
				"completed",
			);
			expect(updateResult.ok).toBe(true);

			const session = getSessionByClaudeId(db, "claude-123");
			if (session.ok && session.value) {
				expect(session.value.status).toBe("completed");
				expect(session.value.completedAt).not.toBeNull();
			}
		});
	});

	describe("incrementPromptCounter", () => {
		it("increments counter and returns new value", () => {
			const createResult = createSession(db, {
				claudeSessionId: "claude-123",
				project: "test-project",
				userPrompt: "Test",
			});

			if (!createResult.ok) throw new Error("Setup failed");

			const result1 = incrementPromptCounter(db, createResult.value.id);
			expect(result1.ok).toBe(true);
			if (result1.ok) expect(result1.value).toBe(2);

			const result2 = incrementPromptCounter(db, createResult.value.id);
			expect(result2.ok).toBe(true);
			if (result2.ok) expect(result2.value).toBe(3);
		});
	});

	describe("storeObservation", () => {
		it("stores observation and returns id", () => {
			const createResult = createSession(db, {
				claudeSessionId: "claude-123",
				project: "test-project",
				userPrompt: "Test",
			});

			if (!createResult.ok) throw new Error("Setup failed");

			const observation: ParsedObservation = {
				type: "feature",
				title: "Added authentication",
				subtitle: "JWT-based auth flow",
				narrative: "Full implementation details",
				facts: ["Uses JWT", "Supports refresh"],
				concepts: ["how-it-works"],
				filesRead: ["auth.ts"],
				filesModified: ["user.ts"],
			};

			const result = storeObservation(db, {
				claudeSessionId: "claude-123",
				project: "test-project",
				observation,
				promptNumber: 1,
				discoveryTokens: 100,
			});

			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value).toBeGreaterThan(0);
			}
		});
	});

	describe("getObservationById", () => {
		it("returns observation when found", () => {
			createSession(db, {
				claudeSessionId: "claude-123",
				project: "test-project",
				userPrompt: "Test",
			});

			const observation: ParsedObservation = {
				type: "bugfix",
				title: "Fixed null check",
				subtitle: null,
				narrative: null,
				facts: [],
				concepts: [],
				filesRead: [],
				filesModified: ["fix.ts"],
			};

			const storeResult = storeObservation(db, {
				claudeSessionId: "claude-123",
				project: "test-project",
				observation,
				promptNumber: 1,
			});

			if (!storeResult.ok) throw new Error("Setup failed");

			const result = getObservationById(db, storeResult.value);

			expect(result.ok).toBe(true);
			if (result.ok && result.value) {
				expect(result.value.type).toBe("bugfix");
				expect(result.value.title).toBe("Fixed null check");
				expect(result.value.filesModified).toEqual(["fix.ts"]);
			}
		});
	});

	describe("getRecentObservations", () => {
		it("returns observations for project in descending order", () => {
			createSession(db, {
				claudeSessionId: "claude-123",
				project: "test-project",
				userPrompt: "Test",
			});

			const obs1: ParsedObservation = {
				type: "feature",
				title: "First",
				subtitle: null,
				narrative: null,
				facts: [],
				concepts: [],
				filesRead: [],
				filesModified: [],
			};

			const obs2: ParsedObservation = {
				type: "bugfix",
				title: "Second",
				subtitle: null,
				narrative: null,
				facts: [],
				concepts: [],
				filesRead: [],
				filesModified: [],
			};

			storeObservation(db, {
				claudeSessionId: "claude-123",
				project: "test-project",
				observation: obs1,
				promptNumber: 1,
			});

			storeObservation(db, {
				claudeSessionId: "claude-123",
				project: "test-project",
				observation: obs2,
				promptNumber: 1,
			});

			const result = getRecentObservations(db, {
				project: "test-project",
				limit: 10,
			});

			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value).toHaveLength(2);
				// Most recent first
				expect(result.value[0].title).toBe("Second");
				expect(result.value[1].title).toBe("First");
			}
		});
	});

	describe("storeSummary", () => {
		it("stores summary and returns id", () => {
			createSession(db, {
				claudeSessionId: "claude-123",
				project: "test-project",
				userPrompt: "Test",
			});

			const summary: ParsedSummary = {
				request: "Implement auth",
				investigated: "Existing patterns",
				learned: "Uses JWT",
				completed: "Basic auth flow",
				nextSteps: "Add OAuth",
				notes: null,
			};

			const result = storeSummary(db, {
				claudeSessionId: "claude-123",
				project: "test-project",
				summary,
				promptNumber: 1,
			});

			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value).toBeGreaterThan(0);
			}
		});
	});

	describe("saveUserPrompt", () => {
		it("stores user prompt", () => {
			createSession(db, {
				claudeSessionId: "claude-123",
				project: "test-project",
				userPrompt: "Initial",
			});

			const result = saveUserPrompt(db, {
				claudeSessionId: "claude-123",
				promptNumber: 1,
				promptText: "Help me fix a bug",
			});

			expect(result.ok).toBe(true);
		});
	});

	describe("searchObservations", () => {
		it("finds observations by text search", () => {
			createSession(db, {
				claudeSessionId: "claude-123",
				project: "test-project",
				userPrompt: "Test",
			});

			const obs: ParsedObservation = {
				type: "feature",
				title: "Authentication system",
				subtitle: "JWT tokens",
				narrative: "Implemented secure authentication",
				facts: ["Uses bcrypt for passwords"],
				concepts: ["security"],
				filesRead: [],
				filesModified: [],
			};

			storeObservation(db, {
				claudeSessionId: "claude-123",
				project: "test-project",
				observation: obs,
				promptNumber: 1,
			});

			const result = searchObservations(db, {
				query: "authentication",
				limit: 10,
			});

			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value.length).toBeGreaterThan(0);
				expect(result.value[0].title).toContain("Authentication");
			}
		});

		it("filters by project", () => {
			createSession(db, {
				claudeSessionId: "session-a",
				project: "project-a",
				userPrompt: "Test",
			});

			createSession(db, {
				claudeSessionId: "session-b",
				project: "project-b",
				userPrompt: "Test",
			});

			const obs: ParsedObservation = {
				type: "feature",
				title: "Test feature",
				subtitle: null,
				narrative: null,
				facts: [],
				concepts: [],
				filesRead: [],
				filesModified: [],
			};

			storeObservation(db, {
				claudeSessionId: "session-a",
				project: "project-a",
				observation: obs,
				promptNumber: 1,
			});

			storeObservation(db, {
				claudeSessionId: "session-b",
				project: "project-b",
				observation: { ...obs, title: "Other feature" },
				promptNumber: 1,
			});

			const result = searchObservations(db, {
				query: "feature",
				project: "project-a",
				limit: 10,
			});

			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value).toHaveLength(1);
				expect(result.value[0].project).toBe("project-a");
			}
		});
	});
});
