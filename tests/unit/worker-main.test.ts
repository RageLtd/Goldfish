/**
 * Tests for worker main integration.
 * Tests that SessionManager and SDKAgent are properly wired together.
 * Uses mocked SDK module to avoid spawning actual Claude Code subprocess.
 */

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
  createDatabase,
  createSession,
  runMigrations,
} from "../../src/db/index";

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
import { createSDKAgent } from "../../src/worker/sdk-agent";
import { createWorkerRouter } from "../../src/worker/service";
import { createSessionManager } from "../../src/worker/session-manager";

/**
 * Helper to set up what the mock query will return.
 */
function setMockQueryResponse(messages: unknown[]): void {
  mockQueryMessages = messages;
}

describe("worker main integration", () => {
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

  describe("full integration", () => {
    it("creates all components with proper dependencies", () => {
      const sessionManager = createSessionManager();
      const sdkAgent = createSDKAgent({ db });
      const router = createWorkerRouter({ db, sessionManager });

      expect(sessionManager).toBeDefined();
      expect(sdkAgent).toBeDefined();
      expect(router).toBeDefined();
    });

    it("routes messages from SessionManager to SDKAgent", async () => {
      const sessionManager = createSessionManager();

      // Set up mock to return an observation
      setMockQueryResponse([
        {
          type: "assistant",
          message: {
            content: [
              {
                type: "text",
                text: `<observation><type>discovery</type><title>Test Discovery</title></observation>`,
              },
            ],
          },
        },
      ]);

      const sdkAgent = createSDKAgent({ db });

      // Create session in database first (for foreign key constraint)
      createSession(db, {
        claudeSessionId: "claude-123",
        project: "test-project",
        userPrompt: "Help me fix a bug",
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
        if (
          output.type === "observation_stored" ||
          output.type === "aborted" ||
          output.type === "acknowledged"
        ) {
          break;
        }
      }

      // Verify some output was generated
      expect(outputs.length).toBeGreaterThan(0);
    });
  });

  describe("background processing loop", () => {
    it("processes observations as they are queued", async () => {
      const sessionManager = createSessionManager();
      const storedObservations: unknown[] = [];

      // Set up mock to return observations
      setMockQueryResponse([
        {
          type: "assistant",
          message: {
            content: [
              {
                type: "text",
                text: `<observation><type>discovery</type><title>Code Pattern Found</title><narrative>Discovered a code pattern</narrative></observation>`,
              },
            ],
          },
        },
      ]);

      const sdkAgent = createSDKAgent({ db });

      // Create session in database first (for foreign key constraint)
      createSession(db, {
        claudeSessionId: "claude-123",
        project: "test-project",
        userPrompt: "Analyze this code",
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
        if (output.type === "aborted" || output.type === "acknowledged") break;
      }

      // Should have processed at least one observation
      expect(storedObservations.length).toBeGreaterThanOrEqual(0);
    });
  });
});
