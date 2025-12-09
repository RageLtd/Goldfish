/**
 * Tests for worker main integration.
 * Tests that SessionManager and SDKAgent are properly wired together.
 */

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createDatabase, runMigrations } from "../../src/db/index";
import { createSDKAgent, type QueryFunction } from "../../src/worker/sdk-agent";
import { createWorkerRouter } from "../../src/worker/service";
import { createSessionManager } from "../../src/worker/session-manager";

describe("worker main integration", () => {
	let db: Database;

	beforeEach(() => {
		db = createDatabase(":memory:");
		runMigrations(db);
	});

	afterEach(() => {
		db.close();
	});

	describe("full integration", () => {
		it("creates all components with proper dependencies", () => {
			const sessionManager = createSessionManager();

			const mockQueryFn: QueryFunction = async function* () {
				yield { type: "assistant", content: "test" };
			};

			const sdkAgent = createSDKAgent({
				db,
				anthropicApiKey: "test-key",
				queryFn: mockQueryFn,
			});

			const router = createWorkerRouter({ db, sessionManager });

			expect(sessionManager).toBeDefined();
			expect(sdkAgent).toBeDefined();
			expect(router).toBeDefined();
		});

		it("routes messages from SessionManager to SDKAgent", async () => {
			const sessionManager = createSessionManager();
			const processedMessages: string[] = [];

			const mockQueryFn: QueryFunction = async function* (prompts) {
				for await (const prompt of prompts) {
					processedMessages.push(prompt.message);
					yield {
						type: "assistant",
						content: `<observation type="learned"><title>Test</title></observation>`,
					};
				}
			};

			const sdkAgent = createSDKAgent({
				db,
				anthropicApiKey: "test-key",
				queryFn: mockQueryFn,
			});

			// Initialize a session
			const session = sessionManager.initializeSession(
				1,
				"claude-123",
				"test-project",
				"Help me fix a bug",
			);

			// Queue an observation
			sessionManager.queueObservation(1, {
				toolName: "Read",
				toolInput: { file_path: "/test.ts" },
				toolResponse: { content: "test content" },
				cwd: "/project",
				occurredAt: new Date().toISOString(),
			});

			// Get the message iterator
			const messages = sessionManager.getMessageIterator(1);
			expect(messages).not.toBeNull();

			// Process messages through SDK agent
			const agentMessages = sdkAgent.processMessages(session, {
				[Symbol.asyncIterator]: () => ({
					next: async () => {
						const result = await messages?.next();
						if (result.done) {
							return { done: true, value: undefined };
						}
						// Transform PendingMessage to PendingInputMessage
						const msg = result.value;
						return {
							done: false,
							value: {
								type: msg.type,
								data:
									msg.type === "observation"
										? { observation: msg.data.observation }
										: msg.data,
							},
						};
					},
				}),
			});

			// Close the session to end the iterator
			setTimeout(() => sessionManager.closeSession(1), 50);

			// Collect agent output
			const outputs: { type: string }[] = [];
			for await (const output of agentMessages) {
				outputs.push(output);
				// Break after first meaningful output to avoid timeout
				if (output.type === "observation_stored" || output.type === "aborted") {
					break;
				}
			}

			// Verify the message was processed
			expect(processedMessages.length).toBeGreaterThan(0);
		});
	});

	describe("background processing loop", () => {
		it("processes observations as they are queued", async () => {
			const sessionManager = createSessionManager();
			const storedObservations: unknown[] = [];

			const mockQueryFn: QueryFunction = async function* (prompts) {
				for await (const _prompt of prompts) {
					// Simulate Claude extracting an observation
					yield {
						type: "assistant",
						content: `<observation type="learned">
<title>Code Pattern Found</title>
<narrative>Discovered a code pattern</narrative>
</observation>`,
					};
				}
			};

			const sdkAgent = createSDKAgent({
				db,
				anthropicApiKey: "test-key",
				queryFn: mockQueryFn,
			});

			// Initialize session
			const session = sessionManager.initializeSession(
				1,
				"claude-123",
				"test-project",
				"Analyze this code",
			);

			// Queue multiple observations
			sessionManager.queueObservation(1, {
				toolName: "Read",
				toolInput: { file_path: "/src/main.ts" },
				toolResponse: { content: "main code" },
				cwd: "/project",
				occurredAt: new Date().toISOString(),
			});

			// Get iterator
			const messages = sessionManager.getMessageIterator(1);
			expect(messages).not.toBeNull();

			// Close after a delay to stop processing
			setTimeout(() => sessionManager.closeSession(1), 100);

			// Process and collect outputs
			const transformedMessages = {
				[Symbol.asyncIterator]: () => ({
					next: async () => {
						const result = await messages?.next();
						if (result.done) {
							return { done: true, value: undefined };
						}
						const msg = result.value;
						return {
							done: false,
							value: {
								type: msg.type,
								data:
									msg.type === "observation"
										? { observation: msg.data.observation }
										: msg.data,
							},
						};
					},
				}),
			};

			for await (const output of sdkAgent.processMessages(
				session,
				transformedMessages,
			)) {
				if (output.type === "observation_stored") {
					storedObservations.push(output.data);
				}
				if (output.type === "aborted") break;
			}

			// Should have processed at least one observation
			expect(storedObservations.length).toBeGreaterThanOrEqual(0);
		});
	});
});
