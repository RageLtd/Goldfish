/**
 * Tests for BackgroundProcessor - manages session processing with proper cleanup.
 * Tests are written first following TDD principles.
 */

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	createDatabase,
	createSession,
	runMigrations,
} from "../../src/db/index";
import {
	type BackgroundProcessorDeps,
	createBackgroundProcessor,
} from "../../src/worker/background-processor";
import { createSDKAgent, type QueryFunction } from "../../src/worker/sdk-agent";
import { createSessionManager } from "../../src/worker/session-manager";

describe("BackgroundProcessor", () => {
	let db: Database;

	beforeEach(() => {
		db = createDatabase(":memory:");
		runMigrations(db);
	});

	afterEach(() => {
		db.close();
	});

	describe("createBackgroundProcessor", () => {
		it("creates a processor with required methods", () => {
			const sessionManager = createSessionManager();
			const mockQueryFn: QueryFunction = async function* () {
				yield { type: "assistant", content: "test" };
			};
			const sdkAgent = createSDKAgent({
				db,
				anthropicApiKey: "test-key",
				queryFn: mockQueryFn,
			});

			const deps: BackgroundProcessorDeps = {
				sessionManager,
				sdkAgent,
				pollIntervalMs: 1000,
			};

			const processor = createBackgroundProcessor(deps);

			expect(processor.start).toBeDefined();
			expect(processor.stop).toBeDefined();
			expect(processor.getActiveProcessingCount).toBeDefined();
			expect(processor.awaitCompletion).toBeDefined();
		});
	});

	describe("start/stop", () => {
		it("starts polling and can be stopped", async () => {
			const sessionManager = createSessionManager();
			const mockQueryFn: QueryFunction = async function* () {
				yield { type: "assistant", content: "test" };
			};
			const sdkAgent = createSDKAgent({
				db,
				anthropicApiKey: "test-key",
				queryFn: mockQueryFn,
			});

			const processor = createBackgroundProcessor({
				sessionManager,
				sdkAgent,
				pollIntervalMs: 50, // Fast polling for test
			});

			processor.start();

			// Let it run briefly
			await new Promise((resolve) => setTimeout(resolve, 100));

			processor.stop();

			// Should be stopped without error
			expect(processor.getActiveProcessingCount()).toBe(0);
		});

		it("does not start multiple times", () => {
			const sessionManager = createSessionManager();
			const mockQueryFn: QueryFunction = async function* () {
				yield { type: "assistant", content: "test" };
			};
			const sdkAgent = createSDKAgent({
				db,
				anthropicApiKey: "test-key",
				queryFn: mockQueryFn,
			});

			const processor = createBackgroundProcessor({
				sessionManager,
				sdkAgent,
				pollIntervalMs: 1000,
			});

			processor.start();
			processor.start(); // Should be idempotent
			processor.stop();
		});
	});

	describe("session processing tracking", () => {
		it("tracks active processing count", async () => {
			const sessionManager = createSessionManager();
			let resolveDelay: () => void;
			const delayPromise = new Promise<void>((resolve) => {
				resolveDelay = resolve;
			});

			const mockQueryFn: QueryFunction = async function* (prompts) {
				for await (const _prompt of prompts) {
					// Wait for signal to continue
					await delayPromise;
					yield { type: "assistant", content: "test" };
				}
			};

			const sdkAgent = createSDKAgent({
				db,
				anthropicApiKey: "test-key",
				queryFn: mockQueryFn,
			});

			const processor = createBackgroundProcessor({
				sessionManager,
				sdkAgent,
				pollIntervalMs: 50,
			});

			// Initialize a session
			sessionManager.initializeSession(1, "claude-123", "test-project", "test");

			processor.start();

			// Wait for processing to start
			await new Promise((resolve) => setTimeout(resolve, 100));

			// Should have 1 active processing
			expect(processor.getActiveProcessingCount()).toBe(1);

			// Release the processing
			resolveDelay?.();
			sessionManager.closeSession(1);

			// Wait for completion
			await processor.awaitCompletion(500);

			expect(processor.getActiveProcessingCount()).toBe(0);

			processor.stop();
		});

		it("does not start duplicate processing for same session", async () => {
			const sessionManager = createSessionManager();
			let processCount = 0;

			const mockQueryFn: QueryFunction = async function* (prompts) {
				processCount++;
				for await (const _prompt of prompts) {
					yield { type: "assistant", content: "test" };
				}
			};

			const sdkAgent = createSDKAgent({
				db,
				anthropicApiKey: "test-key",
				queryFn: mockQueryFn,
			});

			const processor = createBackgroundProcessor({
				sessionManager,
				sdkAgent,
				pollIntervalMs: 50,
			});

			// Initialize a session
			sessionManager.initializeSession(1, "claude-123", "test-project", "test");

			processor.start();

			// Let multiple poll cycles run
			await new Promise((resolve) => setTimeout(resolve, 200));

			// Close session to end processing
			sessionManager.closeSession(1);
			await processor.awaitCompletion(500);

			processor.stop();

			// Should have only started processing once
			expect(processCount).toBe(1);
		});
	});

	describe("awaitCompletion", () => {
		it("waits for all processing to complete", async () => {
			const sessionManager = createSessionManager();

			const mockQueryFn: QueryFunction = async function* (prompts) {
				for await (const _prompt of prompts) {
					await new Promise((resolve) => setTimeout(resolve, 50));
					yield { type: "assistant", content: "test" };
				}
			};

			const sdkAgent = createSDKAgent({
				db,
				anthropicApiKey: "test-key",
				queryFn: mockQueryFn,
			});

			const processor = createBackgroundProcessor({
				sessionManager,
				sdkAgent,
				pollIntervalMs: 50,
			});

			// Initialize session and queue work
			sessionManager.initializeSession(1, "claude-123", "test-project", "test");

			processor.start();

			// Wait for processing to start
			await new Promise((resolve) => setTimeout(resolve, 100));

			// Close session
			sessionManager.closeSession(1);

			// Wait for completion
			await processor.awaitCompletion(1000);

			processor.stop();

			// Processing should have completed
			expect(processor.getActiveProcessingCount()).toBe(0);
		});

		it("times out if processing takes too long", async () => {
			const sessionManager = createSessionManager();
			let neverResolve: Promise<void>;

			const mockQueryFn: QueryFunction = async function* (prompts) {
				for await (const _prompt of prompts) {
					// Never resolve
					neverResolve = new Promise(() => {});
					await neverResolve;
					yield { type: "assistant", content: "test" };
				}
			};

			const sdkAgent = createSDKAgent({
				db,
				anthropicApiKey: "test-key",
				queryFn: mockQueryFn,
			});

			const processor = createBackgroundProcessor({
				sessionManager,
				sdkAgent,
				pollIntervalMs: 50,
			});

			// Initialize session
			sessionManager.initializeSession(1, "claude-123", "test-project", "test");

			processor.start();

			// Wait for processing to start
			await new Promise((resolve) => setTimeout(resolve, 100));

			// Should timeout and not hang forever
			const startTime = Date.now();
			await processor.awaitCompletion(100);
			const elapsed = Date.now() - startTime;

			expect(elapsed).toBeLessThan(200);

			// Force cleanup
			sessionManager.closeSession(1);
			processor.stop();
		});
	});

	describe("error handling", () => {
		it("handles processing errors without crashing", async () => {
			const sessionManager = createSessionManager();
			const errorLogged: string[] = [];

			// biome-ignore lint/correctness/useYield: Testing error path before any yield
			const mockQueryFn: QueryFunction = async function* (_prompts) {
				throw new Error("SDK exploded");
			};

			const sdkAgent = createSDKAgent({
				db,
				anthropicApiKey: "test-key",
				queryFn: mockQueryFn,
			});

			const processor = createBackgroundProcessor({
				sessionManager,
				sdkAgent,
				pollIntervalMs: 50,
				onError: (sessionId, error) => {
					errorLogged.push(`${sessionId}: ${error}`);
				},
			});

			// Initialize session
			sessionManager.initializeSession(1, "claude-123", "test-project", "test");

			processor.start();

			// Wait for error to be handled
			await new Promise((resolve) => setTimeout(resolve, 150));

			processor.stop();

			// Error should have been captured
			expect(errorLogged.length).toBeGreaterThan(0);
			expect(errorLogged[0]).toContain("SDK exploded");
		});

		it("cleans up tracking after error", async () => {
			const sessionManager = createSessionManager();

			// biome-ignore lint/correctness/useYield: Testing error path before any yield
			const mockQueryFn: QueryFunction = async function* (_prompts) {
				throw new Error("SDK error");
			};

			const sdkAgent = createSDKAgent({
				db,
				anthropicApiKey: "test-key",
				queryFn: mockQueryFn,
			});

			const processor = createBackgroundProcessor({
				sessionManager,
				sdkAgent,
				pollIntervalMs: 50,
				onError: () => {}, // Suppress error logging
			});

			// Initialize session
			sessionManager.initializeSession(1, "claude-123", "test-project", "test");

			processor.start();

			// Wait for error and cleanup
			await new Promise((resolve) => setTimeout(resolve, 150));

			// Should have cleaned up tracking
			expect(processor.getActiveProcessingCount()).toBe(0);

			processor.stop();
		});
	});

	describe("event callbacks", () => {
		it("calls onObservationStored callback", async () => {
			const sessionManager = createSessionManager();
			const storedEvents: Array<{ sessionId: string; observationId: number }> =
				[];
			const errors: string[] = [];

			const mockQueryFn: QueryFunction = async function* (prompts) {
				for await (const _prompt of prompts) {
					yield {
						type: "assistant",
						content: `<observation><type>feature</type><title>Test</title></observation>`,
					};
				}
			};

			const sdkAgent = createSDKAgent({
				db,
				anthropicApiKey: "test-key",
				queryFn: mockQueryFn,
			});

			const processor = createBackgroundProcessor({
				sessionManager,
				sdkAgent,
				pollIntervalMs: 50,
				onObservationStored: (sessionId, observationId) => {
					storedEvents.push({ sessionId, observationId });
				},
				onError: (sessionId, error) => {
					errors.push(`${sessionId}: ${error}`);
				},
			});

			// Create session in database (required for foreign key constraint)
			createSession(db, {
				claudeSessionId: "claude-123",
				project: "test-project",
				userPrompt: "test",
			});

			// Initialize session in SessionManager
			sessionManager.initializeSession(1, "claude-123", "test-project", "test");

			processor.start();

			// Wait for processing to start and get first response
			await new Promise((resolve) => setTimeout(resolve, 200));

			// Close to end processing
			sessionManager.closeSession(1);
			await processor.awaitCompletion(500);

			processor.stop();

			// Should have received callback
			expect(storedEvents.length).toBeGreaterThan(0);
			expect(storedEvents[0].sessionId).toBe("claude-123");
		});

		it("calls onSummaryStored callback", async () => {
			const sessionManager = createSessionManager();
			const storedEvents: Array<{ sessionId: string; summaryId: number }> = [];

			const mockQueryFn: QueryFunction = async function* (prompts) {
				for await (const _prompt of prompts) {
					yield {
						type: "assistant",
						content: `<summary>
							<request>Test request</request>
							<investigated>Things</investigated>
							<learned>Stuff</learned>
							<completed>Done</completed>
							<next_steps>More</next_steps>
						</summary>`,
					};
				}
			};

			const sdkAgent = createSDKAgent({
				db,
				anthropicApiKey: "test-key",
				queryFn: mockQueryFn,
			});

			const processor = createBackgroundProcessor({
				sessionManager,
				sdkAgent,
				pollIntervalMs: 50,
				onSummaryStored: (sessionId, summaryId) => {
					storedEvents.push({ sessionId, summaryId });
				},
			});

			// Create session in database (required for foreign key constraint)
			createSession(db, {
				claudeSessionId: "claude-123",
				project: "test-project",
				userPrompt: "test",
			});

			// Initialize session in SessionManager
			sessionManager.initializeSession(1, "claude-123", "test-project", "test");

			// Queue a summarize request
			sessionManager.queueSummarize(1, "final message", "assistant response");

			processor.start();

			// Wait for processing
			await new Promise((resolve) => setTimeout(resolve, 200));

			// Close to end processing
			sessionManager.closeSession(1);
			await processor.awaitCompletion(500);

			processor.stop();

			// Should have received callback
			expect(storedEvents.length).toBeGreaterThan(0);
			expect(storedEvents[0].sessionId).toBe("claude-123");
		});
	});
});
