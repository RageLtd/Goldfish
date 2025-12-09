import { beforeEach, describe, expect, it, mock } from "bun:test";
import {
	type HookDeps,
	processCleanupHook,
	processContextHook,
	processNewHook,
	processSaveHook,
	processSummaryHook,
} from "../../src/hooks/logic";
import type {
	PostToolUseInput,
	SessionEndInput,
	SessionStartInput,
	StopInput,
	UserPromptSubmitInput,
} from "../../src/types/hooks";

describe("hook logic", () => {
	let mockFetch: ReturnType<typeof mock>;
	let deps: HookDeps;

	beforeEach(() => {
		mockFetch = mock(() =>
			Promise.resolve({
				ok: true,
				json: () => Promise.resolve({ status: "ok" }),
			}),
		);
		deps = {
			fetch: mockFetch as unknown as typeof fetch,
			workerUrl: "http://127.0.0.1:3456",
		};
	});

	describe("processContextHook (SessionStart)", () => {
		it("fetches context and returns additionalContext", async () => {
			mockFetch.mockImplementation(() =>
				Promise.resolve({
					ok: true,
					json: () =>
						Promise.resolve({
							context: "## Previous work\n- Did stuff",
							observationCount: 5,
							summaryCount: 2,
						}),
				}),
			);

			const input: SessionStartInput = {
				session_id: "session-123",
				cwd: "/projects/test",
				source: "startup",
			};

			const result = await processContextHook(deps, input);

			expect(result.continue).toBe(true);
			expect(result.hookSpecificOutput?.additionalContext).toContain(
				"Previous work",
			);
			expect(mockFetch).toHaveBeenCalledTimes(1);
		});

		it("returns empty context when no project detected", async () => {
			const input: SessionStartInput = {
				source: "startup",
			};

			const result = await processContextHook(deps, input);

			expect(result.continue).toBe(true);
			// Should not make fetch call without project
			expect(mockFetch).not.toHaveBeenCalled();
		});

		it("handles fetch error gracefully", async () => {
			mockFetch.mockImplementation(() =>
				Promise.reject(new Error("Network error")),
			);

			const input: SessionStartInput = {
				session_id: "session-123",
				cwd: "/projects/test",
				source: "startup",
			};

			const result = await processContextHook(deps, input);

			expect(result.continue).toBe(true);
			// Should continue even on error
		});
	});

	describe("processSaveHook (PostToolUse)", () => {
		it("sends observation to worker", async () => {
			mockFetch.mockImplementation(() =>
				Promise.resolve({
					ok: true,
					json: () => Promise.resolve({ status: "queued" }),
				}),
			);

			const input: PostToolUseInput = {
				session_id: "session-123",
				cwd: "/projects/test",
				tool_name: "Bash",
				tool_input: { command: "git status" },
				tool_response: { stdout: "On branch main" },
			};

			const result = await processSaveHook(deps, input);

			expect(result.continue).toBe(true);
			expect(result.suppressOutput).toBe(true);
			expect(mockFetch).toHaveBeenCalledTimes(1);

			// Verify the request body
			const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
			expect(url).toBe("http://127.0.0.1:3456/observation");
			expect(options.method).toBe("POST");
			const body = JSON.parse(options.body as string);
			expect(body.claudeSessionId).toBe("session-123");
			expect(body.toolName).toBe("Bash");
		});

		it("returns success even if worker fails", async () => {
			mockFetch.mockImplementation(() =>
				Promise.reject(new Error("Worker down")),
			);

			const input: PostToolUseInput = {
				session_id: "session-123",
				cwd: "/projects/test",
				tool_name: "Read",
				tool_input: { file_path: "/test.ts" },
				tool_response: { content: "code" },
			};

			const result = await processSaveHook(deps, input);

			expect(result.continue).toBe(true);
			// Fire-and-forget: don't block Claude Code
		});

		it("strips private tags from tool response", async () => {
			const input: PostToolUseInput = {
				session_id: "session-123",
				cwd: "/projects/test",
				tool_name: "Read",
				tool_input: { file_path: "/test.ts" },
				tool_response: "Public<private>Secret</private>Content",
			};

			await processSaveHook(deps, input);

			const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
			const body = JSON.parse(options.body as string);
			// Response should have private tags stripped
			expect(body.toolResponse).not.toContain("Secret");
			expect(body.toolResponse).toContain("Public");
			expect(body.toolResponse).toContain("Content");
		});
	});

	describe("processNewHook (UserPromptSubmit)", () => {
		it("strips private tags from prompt before storage", async () => {
			const input: UserPromptSubmitInput = {
				session_id: "session-123",
				cwd: "/projects/test",
				prompt: "Help me <private>with secret stuff</private> fix a bug",
			};

			const result = await processNewHook(deps, input);

			expect(result.continue).toBe(true);

			// Check the stored prompt has private content stripped
			if (mockFetch.mock.calls.length > 0) {
				const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
				const body = JSON.parse(options.body as string);
				expect(body.prompt).not.toContain("secret stuff");
			}
		});

		it("skips entirely private prompts", async () => {
			const input: UserPromptSubmitInput = {
				session_id: "session-123",
				cwd: "/projects/test",
				prompt: "<private>Everything is private</private>",
			};

			const result = await processNewHook(deps, input);

			expect(result.continue).toBe(true);
			// Should not store entirely private prompts
		});
	});

	describe("processSummaryHook (Stop)", () => {
		it("queues summary request", async () => {
			mockFetch.mockImplementation(() =>
				Promise.resolve({
					ok: true,
					json: () => Promise.resolve({ status: "queued" }),
				}),
			);

			const input: StopInput = {
				session_id: "session-123",
				cwd: "/projects/test",
				transcript_path: "/tmp/transcript.json",
			};

			const result = await processSummaryHook(deps, input);

			expect(result.continue).toBe(true);
			expect(mockFetch).toHaveBeenCalledTimes(1);

			const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
			expect(url).toBe("http://127.0.0.1:3456/summary");
		});

		it("handles missing transcript path", async () => {
			const input: StopInput = {
				session_id: "session-123",
				cwd: "/projects/test",
			};

			const result = await processSummaryHook(deps, input);

			expect(result.continue).toBe(true);
		});
	});

	describe("processCleanupHook (SessionEnd)", () => {
		it("marks session as completed", async () => {
			mockFetch.mockImplementation(() =>
				Promise.resolve({
					ok: true,
					json: () => Promise.resolve({ status: "completed" }),
				}),
			);

			const input: SessionEndInput = {
				session_id: "session-123",
				cwd: "/projects/test",
				hook_event_name: "SessionEnd",
				reason: "exit",
			};

			const result = await processCleanupHook(deps, input);

			expect(result.continue).toBe(true);
			expect(mockFetch).toHaveBeenCalledTimes(1);

			const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
			expect(url).toBe("http://127.0.0.1:3456/complete");
			const body = JSON.parse(options.body as string);
			expect(body.reason).toBe("exit");
		});

		it("handles logout reason", async () => {
			const input: SessionEndInput = {
				session_id: "session-123",
				cwd: "/projects/test",
				hook_event_name: "SessionEnd",
				reason: "logout",
			};

			const result = await processCleanupHook(deps, input);

			expect(result.continue).toBe(true);
		});
	});
});
