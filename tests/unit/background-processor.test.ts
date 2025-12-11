/**
 * Tests for BackgroundProcessor - manages session processing with proper cleanup.
 * Uses mocked SDK module to avoid spawning actual Claude Code subprocess.
 */

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
	createDatabase,
	createSession,
	runMigrations,
} from "../../src/db/index";
import { createSessionManager } from "../../src/worker/session-manager";

// Track what the mock query should return
let mockQueryMessages: unknown[] = [];

// Mock the SDK module - must be done before importing modules that use it
mock.module("@anthropic-ai/claude-agent-sdk", () => ({
	query: mock(() => {
		return (async function* () {
			for (const msg of mockQueryMessages) {
				yield msg;
			}
		})();
	}),
}));

// Import after mocking
import {
	type BackgroundProcessorDeps,
	createBackgroundProcessor,
} from "../../src/worker/background-processor";
import { createSDKAgent } from "../../src/worker/sdk-agent";

/**
 * Helper to set up what the mock query will return.
 */
function setMockQueryResponse(messages: unknown[]): void {
	mockQueryMessages = messages;
}

describe("BackgroundProcessor", () => {
	let db: Database;

	beforeEach(() => {
		db = createDatabase(":memory:");
		runMigrations(db);
		// Reset mock messages
		setMockQueryResponse([]);
	});

	afterEach(() => {
		db.close();
	});

	describe("createBackgroundProcessor", () => {
		it("creates a processor with required methods", () => {
			const sessionManager = createSessionManager();
			const sdkAgent = createSDKAgent({ db });

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
			const sdkAgent = createSDKAgent({ db });

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
			const sdkAgent = createSDKAgent({ db });

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

			// Set up a mock response that takes time
			setMockQueryResponse([
				{
					type: "assistant",
					message: {
						content: [{ type: "text", text: "Processing..." }],
					},
				},
			]);

			const sdkAgent = createSDKAgent({ db });

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

			// Close session to end processing
			sessionManager.closeSession(1);

			// Wait for completion
			await processor.awaitCompletion(500);

			expect(processor.getActiveProcessingCount()).toBe(0);

			processor.stop();
		});

		it("does not start duplicate processing for same session", async () => {
			const sessionManager = createSessionManager();

			// Mock returns acknowledgment
			setMockQueryResponse([
				{
					type: "assistant",
					message: {
						content: [{ type: "text", text: "Acknowledged" }],
					},
				},
			]);

			const sdkAgent = createSDKAgent({ db });

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

			// Should complete without duplicates (verified by no errors)
			expect(processor.getActiveProcessingCount()).toBe(0);
		});
	});

	describe("awaitCompletion", () => {
		it("waits for all processing to complete", async () => {
			const sessionManager = createSessionManager();

			setMockQueryResponse([
				{
					type: "assistant",
					message: {
						content: [{ type: "text", text: "Done" }],
					},
				},
			]);

			const sdkAgent = createSDKAgent({ db });

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

			// Empty response - processing will wait for messages
			setMockQueryResponse([]);

			const sdkAgent = createSDKAgent({ db });

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
		it("handles empty sessions gracefully", async () => {
			const sessionManager = createSessionManager();

			setMockQueryResponse([]);

			const sdkAgent = createSDKAgent({ db });

			const processor = createBackgroundProcessor({
				sessionManager,
				sdkAgent,
				pollIntervalMs: 50,
			});

			processor.start();

			// Let it run with no sessions
			await new Promise((resolve) => setTimeout(resolve, 100));

			processor.stop();

			// Should be stopped without error
			expect(processor.getActiveProcessingCount()).toBe(0);
		});
	});

	describe("event callbacks", () => {
		it("calls onObservationStored callback", async () => {
			const sessionManager = createSessionManager();
			const storedEvents: Array<{ sessionId: string; observationId: number }> =
				[];

			// Mock returns observation XML
			setMockQueryResponse([
				{
					type: "assistant",
					message: {
						content: [
							{
								type: "text",
								text: `<observation><type>feature</type><title>Test</title></observation>`,
							},
						],
					},
				},
			]);

			const sdkAgent = createSDKAgent({ db });

			const processor = createBackgroundProcessor({
				sessionManager,
				sdkAgent,
				pollIntervalMs: 50,
				onObservationStored: (sessionId, observationId) => {
					storedEvents.push({ sessionId, observationId });
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

			// Mock returns summary XML
			setMockQueryResponse([
				{
					type: "assistant",
					message: {
						content: [
							{
								type: "text",
								text: `<summary>
							<request>Test request</request>
							<investigated>Things</investigated>
							<learned>Stuff</learned>
							<completed>Done</completed>
							<next_steps>More</next_steps>
						</summary>`,
							},
						],
					},
				},
			]);

			const sdkAgent = createSDKAgent({ db });

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
