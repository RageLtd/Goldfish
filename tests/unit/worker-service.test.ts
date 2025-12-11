import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	createDatabase,
	createSession,
	runMigrations,
} from "../../src/db/index";
import {
	createWorkerRouter,
	type WorkerRouter,
} from "../../src/worker/service";

describe("worker service router", () => {
	let db: Database;
	let router: WorkerRouter;

	beforeEach(() => {
		db = createDatabase(":memory:");
		runMigrations(db);
		router = createWorkerRouter({ db });
	});

	afterEach(() => {
		db.close();
	});

	describe("GET /health", () => {
		it("returns 200 with ok status", async () => {
			const request = new Request("http://localhost/health");
			const response = await router.handle(request);

			expect(response.status).toBe(200);
			const body = await response.json();
			expect(body.status).toBe("ok");
		});
	});

	describe("POST /observation", () => {
		it("queues observation for valid request", async () => {
			createSession(db, {
				claudeSessionId: "claude-123",
				project: "test-project",
				userPrompt: "Test",
			});

			const request = new Request("http://localhost/observation", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					claudeSessionId: "claude-123",
					toolName: "Bash",
					toolInput: { command: "ls" },
					toolResponse: { stdout: "file.txt" },
					cwd: "/project",
				}),
			});

			const response = await router.handle(request);

			expect(response.status).toBe(200);
			const body = await response.json();
			expect(body.status).toBe("queued");
		});

		it("returns 400 for missing claudeSessionId", async () => {
			const request = new Request("http://localhost/observation", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					toolName: "Bash",
					toolInput: {},
					toolResponse: {},
					cwd: "",
				}),
			});

			const response = await router.handle(request);

			expect(response.status).toBe(400);
		});

		it("returns 400 for invalid JSON", async () => {
			const request = new Request("http://localhost/observation", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: "not json",
			});

			const response = await router.handle(request);

			expect(response.status).toBe(400);
		});
	});

	describe("POST /summary", () => {
		it("queues summary for valid request", async () => {
			createSession(db, {
				claudeSessionId: "claude-123",
				project: "test-project",
				userPrompt: "Test",
			});

			const request = new Request("http://localhost/summary", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					claudeSessionId: "claude-123",
					lastUserMessage: "Fix the bug",
					lastAssistantMessage: "Done",
				}),
			});

			const response = await router.handle(request);

			expect(response.status).toBe(200);
			const body = await response.json();
			expect(body.status).toBe("queued");
		});

		it("returns 404 for unknown session", async () => {
			const request = new Request("http://localhost/summary", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					claudeSessionId: "unknown",
					lastUserMessage: "Fix",
					lastAssistantMessage: "Done",
				}),
			});

			const response = await router.handle(request);

			expect(response.status).toBe(404);
		});
	});

	describe("POST /prompt", () => {
		it("stores prompt for new session", async () => {
			const request = new Request("http://localhost/prompt", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					claudeSessionId: "claude-new",
					prompt: "Help me fix a bug",
					cwd: "/projects/my-app",
				}),
			});

			const response = await router.handle(request);

			expect(response.status).toBe(200);
			const body = await response.json();
			expect(body.status).toBe("stored");
		});

		it("returns 400 for missing prompt", async () => {
			const request = new Request("http://localhost/prompt", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					claudeSessionId: "claude-123",
					prompt: "",
					cwd: "/projects",
				}),
			});

			const response = await router.handle(request);

			expect(response.status).toBe(400);
		});
	});

	describe("POST /complete", () => {
		it("marks session as completed", async () => {
			createSession(db, {
				claudeSessionId: "claude-123",
				project: "test-project",
				userPrompt: "Test",
			});

			const request = new Request("http://localhost/complete", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					claudeSessionId: "claude-123",
					reason: "exit",
				}),
			});

			const response = await router.handle(request);

			expect(response.status).toBe(200);
			const body = await response.json();
			expect(body.status).toBe("completed");
		});
	});

	describe("GET /context", () => {
		it("returns context for project", async () => {
			const request = new Request(
				"http://localhost/context?project=test-project&limit=10",
			);
			const response = await router.handle(request);

			expect(response.status).toBe(200);
			const body = await response.json();
			expect(typeof body.context).toBe("string");
		});

		it("returns 400 for missing project param", async () => {
			const request = new Request("http://localhost/context");
			const response = await router.handle(request);

			expect(response.status).toBe(400);
		});
	});

	describe("GET /search", () => {
		it("searches observations", async () => {
			const request = new Request(
				"http://localhost/search?query=auth&type=observations&limit=10",
			);
			const response = await router.handle(request);

			expect(response.status).toBe(200);
			const body = await response.json();
			expect(Array.isArray(body.results)).toBe(true);
		});

		it("returns 400 for missing query param", async () => {
			const request = new Request(
				"http://localhost/search?type=observations&limit=10",
			);
			const response = await router.handle(request);

			expect(response.status).toBe(400);
		});

		it("returns 400 for invalid type", async () => {
			const request = new Request(
				"http://localhost/search?query=test&type=invalid&limit=10",
			);
			const response = await router.handle(request);

			expect(response.status).toBe(400);
		});
	});

	describe("GET /timeline", () => {
		it("returns timeline for project", async () => {
			const request = new Request(
				"http://localhost/timeline?project=test-project&limit=10",
			);
			const response = await router.handle(request);

			expect(response.status).toBe(200);
			const body = await response.json();
			expect(Array.isArray(body.results)).toBe(true);
			expect(typeof body.count).toBe("number");
		});

		it("works without project parameter", async () => {
			const request = new Request("http://localhost/timeline?limit=10");
			const response = await router.handle(request);

			expect(response.status).toBe(200);
			const body = await response.json();
			expect(Array.isArray(body.results)).toBe(true);
		});
	});

	describe("GET /decisions", () => {
		it("returns decisions for project", async () => {
			const request = new Request(
				"http://localhost/decisions?project=test-project&limit=10",
			);
			const response = await router.handle(request);

			expect(response.status).toBe(200);
			const body = await response.json();
			expect(Array.isArray(body.results)).toBe(true);
		});

		it("works without project parameter", async () => {
			const request = new Request("http://localhost/decisions?limit=10");
			const response = await router.handle(request);

			expect(response.status).toBe(200);
			const body = await response.json();
			expect(Array.isArray(body.results)).toBe(true);
		});
	});

	describe("GET /find_by_file", () => {
		it("finds observations by file", async () => {
			const request = new Request(
				"http://localhost/find_by_file?file=src/auth.ts&limit=10",
			);
			const response = await router.handle(request);

			expect(response.status).toBe(200);
			const body = await response.json();
			expect(Array.isArray(body.results)).toBe(true);
		});

		it("returns 400 for missing file parameter", async () => {
			const request = new Request("http://localhost/find_by_file?limit=10");
			const response = await router.handle(request);

			expect(response.status).toBe(400);
			const body = await response.json();
			expect(body.error).toContain("file parameter is required");
		});
	});

	describe("unknown routes", () => {
		it("returns 404 for unknown path", async () => {
			const request = new Request("http://localhost/unknown");
			const response = await router.handle(request);

			expect(response.status).toBe(404);
		});

		it("returns 405 for wrong method on known path", async () => {
			const request = new Request("http://localhost/health", {
				method: "POST",
			});
			const response = await router.handle(request);

			expect(response.status).toBe(405);
		});
	});
});
