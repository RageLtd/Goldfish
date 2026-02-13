/**
 * Tests for SDKAgent - Claude AI processing for observations.
 * Uses mocked SDK module to avoid spawning actual Claude Code subprocess.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { ChromaSync } from "../../src/services/chroma-sync";
import type { ActiveSession } from "../../src/worker/session-manager";

// Track what the mock query should return
let mockQueryMessages: unknown[] = [];

// Track what options were passed to query
let lastQueryOptions: unknown = null;

// Mock the SDK module - must be done before importing the module that uses it
mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: mock((params: { options?: unknown }) => {
    lastQueryOptions = params.options;
    return (async function* () {
      for (const msg of mockQueryMessages) {
        yield msg;
      }
    })();
  }),
}));

// Import after mocking
import {
  createSDKAgent,
  type SDKAgentDeps,
  type SDKAgentMessage,
} from "../../src/worker/sdk-agent";

/**
 * Helper to set up what the mock query will return.
 */
function setMockQueryResponse(messages: unknown[]): void {
  mockQueryMessages = messages;
}

/**
 * Helper to get the last options passed to query.
 */
function getLastQueryOptions(): Record<string, unknown> | null {
  return lastQueryOptions as Record<string, unknown> | null;
}

// ============================================================================
// Test Helpers
// ============================================================================

const createMockSession = (
  overrides: Partial<ActiveSession> = {},
): ActiveSession => ({
  sessionDbId: 1,
  claudeSessionId: "claude-123",
  project: "test-project",
  userPrompt: "test user prompt",
  startedAt: Date.now(),
  abortController: new AbortController(),
  ...overrides,
});

const createMockDb = (): Database => {
  return {
    run: mock(() => ({ lastInsertRowid: 1, changes: 1 })),
    query: mock(() => ({
      get: mock(() => ({ id: 1 })),
      all: mock(() => []),
    })),
  } as unknown as Database;
};

// ============================================================================
// Tests
// ============================================================================

describe("SDKAgent", () => {
  beforeEach(() => {
    // Reset mock messages and captured options before each test
    setMockQueryResponse([]);
    lastQueryOptions = null;
  });

  describe("createSDKAgent", () => {
    it("creates an agent with required methods", () => {
      const deps: SDKAgentDeps = {
        db: createMockDb(),
      };

      const agent = createSDKAgent(deps);

      expect(agent.processMessages).toBeDefined();
      expect(typeof agent.processMessages).toBe("function");
    });
  });

  describe("processMessages", () => {
    it("yields observation when SDK returns observation XML", async () => {
      const mockDb = createMockDb();
      const deps: SDKAgentDeps = {
        db: mockDb,
      };

      // Set up what the mocked SDK will return
      setMockQueryResponse([
        {
          type: "assistant",
          message: {
            content: [
              {
                type: "text",
                text: `<observation>
							<type>feature</type>
							<title>Added new feature</title>
							<subtitle>Implemented user auth</subtitle>
							<narrative>Full OAuth2 implementation</narrative>
							<facts><fact>Uses PKCE flow</fact></facts>
							<concepts><concept>how-it-works</concept></concepts>
							<files_read><file>src/auth.ts</file></files_read>
							<files_modified><file>src/auth.ts</file></files_modified>
						</observation>`,
              },
            ],
          },
        },
      ]);

      const agent = createSDKAgent(deps);
      const session = createMockSession();

      const messages: SDKAgentMessage[] = [];
      async function* inputMessages() {
        yield {
          type: "observation" as const,
          data: {
            observation: {
              toolName: "Write",
              toolInput: {},
              toolResponse: {},
              cwd: "/test",
              occurredAt: new Date().toISOString(),
            },
          },
        };
      }

      for await (const msg of agent.processMessages(session, inputMessages())) {
        messages.push(msg);
      }

      expect(messages.length).toBeGreaterThan(0);
      expect(messages.some((m) => m.type === "observation_stored")).toBe(true);
    });

    it("yields summary when SDK returns summary XML", async () => {
      const mockDb = createMockDb();
      const deps: SDKAgentDeps = {
        db: mockDb,
      };

      setMockQueryResponse([
        {
          type: "assistant",
          message: {
            content: [
              {
                type: "text",
                text: `<summary>
							<request>Implement auth feature</request>
							<investigated>OAuth2 providers</investigated>
							<learned>PKCE is more secure</learned>
							<completed>Full auth flow</completed>
							<next_steps>Add MFA support</next_steps>
							<notes>Consider biometric auth</notes>
						</summary>`,
              },
            ],
          },
        },
      ]);

      const agent = createSDKAgent(deps);
      const session = createMockSession();

      const messages: SDKAgentMessage[] = [];
      async function* inputMessages() {
        yield {
          type: "summarize" as const,
          data: {
            lastUserMessage: "Done for now",
            lastAssistantMessage: "All set",
          },
        };
      }

      for await (const msg of agent.processMessages(session, inputMessages())) {
        messages.push(msg);
      }

      expect(messages.length).toBeGreaterThan(0);
      expect(messages.some((m) => m.type === "summary_stored")).toBe(true);
    });

    it("handles abort signal", async () => {
      const abortController = new AbortController();
      const deps: SDKAgentDeps = {
        db: createMockDb(),
      };

      // Mock will yield nothing since we abort immediately
      setMockQueryResponse([]);

      const agent = createSDKAgent(deps);
      const session = createMockSession({ abortController });

      async function* inputMessages() {
        yield {
          type: "observation" as const,
          data: {
            observation: {
              toolName: "Read",
              toolInput: {},
              toolResponse: {},
              cwd: "/test",
              occurredAt: new Date().toISOString(),
            },
          },
        };
      }

      // Abort immediately
      abortController.abort();

      const messages: SDKAgentMessage[] = [];
      for await (const msg of agent.processMessages(session, inputMessages())) {
        messages.push(msg);
      }

      // Should handle abort gracefully
      expect(messages.some((m) => m.type === "aborted")).toBe(true);
    });

    it("handles SDK errors gracefully", async () => {
      const deps: SDKAgentDeps = {
        db: createMockDb(),
      };

      // Mock SDK returns an assistant message without observation XML
      // This simulates a non-error response that doesn't produce observations
      setMockQueryResponse([
        {
          type: "assistant",
          message: {
            content: [
              {
                type: "text",
                text: "I encountered an issue processing that request.",
              },
            ],
          },
        },
      ]);

      const agent = createSDKAgent(deps);
      const session = createMockSession();

      async function* inputMessages() {
        yield {
          type: "observation" as const,
          data: {
            observation: {
              toolName: "Read",
              toolInput: {},
              toolResponse: {},
              cwd: "/test",
              occurredAt: new Date().toISOString(),
            },
          },
        };
      }

      const messages: SDKAgentMessage[] = [];
      for await (const msg of agent.processMessages(session, inputMessages())) {
        messages.push(msg);
      }

      // Should acknowledge since no observation XML was found
      expect(
        messages.some((m) => m.type === "acknowledged" || m.type === "error"),
      ).toBe(true);
    });

    it("skips routine operations", async () => {
      const mockDb = createMockDb();
      const deps: SDKAgentDeps = {
        db: mockDb,
      };

      // Agent acknowledges but doesn't produce observation XML
      setMockQueryResponse([
        {
          type: "assistant",
          message: {
            content: [
              {
                type: "text",
                text: "Acknowledged routine operation.",
              },
            ],
          },
        },
      ]);

      const agent = createSDKAgent(deps);
      const session = createMockSession();

      async function* inputMessages() {
        yield {
          type: "observation" as const,
          data: {
            observation: {
              toolName: "LS",
              toolInput: { path: "." },
              toolResponse: { files: ["a.ts", "b.ts"] },
              cwd: "/test",
              occurredAt: new Date().toISOString(),
            },
          },
        };
      }

      const messages: SDKAgentMessage[] = [];
      for await (const msg of agent.processMessages(session, inputMessages())) {
        messages.push(msg);
      }

      // Should not store observation for routine operations
      expect(messages.some((m) => m.type === "observation_stored")).toBe(false);
    });
  });

  describe("continuation handling", () => {
    it("processes continuation messages", async () => {
      const mockDb = createMockDb();
      const deps: SDKAgentDeps = {
        db: mockDb,
      };

      // Mock SDK returns acknowledgment
      setMockQueryResponse([
        {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "Acknowledged continuation" }],
          },
        },
      ]);

      const agent = createSDKAgent(deps);
      const session = createMockSession();

      async function* inputMessages() {
        yield {
          type: "continuation" as const,
          data: {
            userPrompt: "Follow up request",
            promptNumber: 2,
          },
        };
      }

      const messages: SDKAgentMessage[] = [];
      for await (const msg of agent.processMessages(session, inputMessages())) {
        messages.push(msg);
      }

      // Should acknowledge the continuation (no observation XML)
      expect(messages.some((m) => m.type === "acknowledged")).toBe(true);
    });
  });

  describe("token tracking", () => {
    it("tracks discovery tokens in stored observations", async () => {
      const mockDb = createMockDb();
      let storedTokens = 0;

      mockDb.run = mock((sql: string, params: unknown[]) => {
        if (sql.includes("INSERT INTO observations")) {
          // discoveryTokens is the 12th param
          storedTokens = params[11] as number;
        }
        return { lastInsertRowid: 1, changes: 1 };
      });

      const deps: SDKAgentDeps = {
        db: mockDb,
      };

      // Mock SDK returns observation with usage info
      setMockQueryResponse([
        {
          type: "result",
          subtype: "success",
          usage: { input_tokens: 100, output_tokens: 50 },
        },
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

      const agent = createSDKAgent(deps);
      const session = createMockSession();

      async function* inputMessages() {
        yield {
          type: "observation" as const,
          data: {
            observation: {
              toolName: "Write",
              toolInput: {},
              toolResponse: {},
              cwd: "/test",
              occurredAt: new Date().toISOString(),
            },
          },
        };
      }

      for await (const _ of agent.processMessages(session, inputMessages())) {
        // consume iterator
      }

      expect(storedTokens).toBeGreaterThan(0);
    });
  });

  describe("ChromaSync integration", () => {
    it("syncs observations to ChromaDB when chromaSync is provided", async () => {
      const mockDb = createMockDb();
      const addedObservations: unknown[] = [];

      const mockChromaSync: ChromaSync = {
        addObservation: mock(async (input) => {
          addedObservations.push(input);
          return { ok: true, value: undefined };
        }),
        addSummary: mock(async () => ({ ok: true, value: undefined })),
        semanticSearch: mock(async () => ({ ok: true, value: [] })),
        deleteBySessionId: mock(async () => ({ ok: true, value: undefined })),
      };

      const deps: SDKAgentDeps = {
        db: mockDb,
        chromaSync: mockChromaSync,
      };

      setMockQueryResponse([
        {
          type: "assistant",
          message: {
            content: [
              {
                type: "text",
                text: `<observation>
							<type>feature</type>
							<title>New Feature</title>
							<narrative>Implemented feature</narrative>
							<concepts><concept>pattern</concept></concepts>
							<files_read></files_read>
							<files_modified></files_modified>
						</observation>`,
              },
            ],
          },
        },
      ]);

      const agent = createSDKAgent(deps);
      const session = createMockSession();

      async function* inputMessages() {
        yield {
          type: "observation" as const,
          data: {
            observation: {
              toolName: "Write",
              toolInput: {},
              toolResponse: {},
              cwd: "/test",
              occurredAt: new Date().toISOString(),
            },
          },
        };
      }

      for await (const _ of agent.processMessages(session, inputMessages())) {
        // consume iterator
      }

      // ChromaSync should have been called
      expect(addedObservations.length).toBe(1);
      expect((addedObservations[0] as { sessionId: string }).sessionId).toBe(
        session.claudeSessionId,
      );
    });

    it("syncs summaries to ChromaDB when chromaSync is provided", async () => {
      const mockDb = createMockDb();
      const addedSummaries: unknown[] = [];

      const mockChromaSync: ChromaSync = {
        addObservation: mock(async () => ({ ok: true, value: undefined })),
        addSummary: mock(async (input) => {
          addedSummaries.push(input);
          return { ok: true, value: undefined };
        }),
        semanticSearch: mock(async () => ({ ok: true, value: [] })),
        deleteBySessionId: mock(async () => ({ ok: true, value: undefined })),
      };

      const deps: SDKAgentDeps = {
        db: mockDb,
        chromaSync: mockChromaSync,
      };

      setMockQueryResponse([
        {
          type: "assistant",
          message: {
            content: [
              {
                type: "text",
                text: `<summary>
							<request>Implement feature</request>
							<investigated>Options</investigated>
							<learned>Best approach</learned>
							<completed>Done</completed>
							<next_steps>Test</next_steps>
						</summary>`,
              },
            ],
          },
        },
      ]);

      const agent = createSDKAgent(deps);
      const session = createMockSession();

      async function* inputMessages() {
        yield {
          type: "summarize" as const,
          data: {
            lastUserMessage: "Done",
            lastAssistantMessage: "All set",
          },
        };
      }

      for await (const _ of agent.processMessages(session, inputMessages())) {
        // consume iterator
      }

      // ChromaSync should have been called
      expect(addedSummaries.length).toBe(1);
      expect((addedSummaries[0] as { sessionId: string }).sessionId).toBe(
        session.claudeSessionId,
      );
    });

    it("continues without error if chromaSync fails", async () => {
      const mockDb = createMockDb();

      const mockChromaSync: ChromaSync = {
        addObservation: mock(async () => ({
          ok: false,
          error: new Error("ChromaDB unavailable"),
        })),
        addSummary: mock(async () => ({ ok: true, value: undefined })),
        semanticSearch: mock(async () => ({ ok: true, value: [] })),
        deleteBySessionId: mock(async () => ({ ok: true, value: undefined })),
      };

      const deps: SDKAgentDeps = {
        db: mockDb,
        chromaSync: mockChromaSync,
      };

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

      const agent = createSDKAgent(deps);
      const session = createMockSession();

      async function* inputMessages() {
        yield {
          type: "observation" as const,
          data: {
            observation: {
              toolName: "Write",
              toolInput: {},
              toolResponse: {},
              cwd: "/test",
              occurredAt: new Date().toISOString(),
            },
          },
        };
      }

      const messages: SDKAgentMessage[] = [];
      for await (const msg of agent.processMessages(session, inputMessages())) {
        messages.push(msg);
      }

      // Should still store observation despite ChromaDB failure
      expect(messages.some((m) => m.type === "observation_stored")).toBe(true);
    });
  });

  describe("storage error reporting", () => {
    it("yields error when observation storage fails", async () => {
      // Create a mock db that fails on observation insert
      const mockDb = {
        run: mock(() => {
          throw new Error("Database constraint violation");
        }),
        query: mock(() => ({
          get: mock(() => null),
          all: mock(() => []),
        })),
      } as unknown as Database;

      const deps: SDKAgentDeps = {
        db: mockDb,
      };

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

      const agent = createSDKAgent(deps);
      const session = createMockSession();

      async function* inputMessages() {
        yield {
          type: "observation" as const,
          data: {
            observation: {
              toolName: "Write",
              toolInput: {},
              toolResponse: {},
              cwd: "/test",
              occurredAt: new Date().toISOString(),
            },
          },
        };
      }

      const messages: SDKAgentMessage[] = [];
      for await (const msg of agent.processMessages(session, inputMessages())) {
        messages.push(msg);
      }

      // Should yield error message for storage failure
      const errorMessage = messages.find((m) => m.type === "error");
      expect(errorMessage).toBeDefined();
      expect(String(errorMessage?.data)).toContain(
        "Failed to store observation",
      );
    });

    it("yields error when summary storage fails", async () => {
      // Create a mock db that fails on summary insert
      const mockDb = {
        run: mock(() => {
          throw new Error("Database constraint violation");
        }),
        query: mock(() => ({
          get: mock(() => null),
          all: mock(() => []),
        })),
      } as unknown as Database;

      const deps: SDKAgentDeps = {
        db: mockDb,
      };

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

      const agent = createSDKAgent(deps);
      const session = createMockSession();

      async function* inputMessages() {
        yield {
          type: "summarize" as const,
          data: {
            lastUserMessage: "Done",
            lastAssistantMessage: "All set",
          },
        };
      }

      const messages: SDKAgentMessage[] = [];
      for await (const msg of agent.processMessages(session, inputMessages())) {
        messages.push(msg);
      }

      // Should yield error message for storage failure
      const errorMessage = messages.find((m) => m.type === "error");
      expect(errorMessage).toBeDefined();
      expect(String(errorMessage?.data)).toContain("Failed to store summary");
    });
  });

  describe("Claude executable path", () => {
    it("passes pathToClaudeCodeExecutable to SDK query when executable is found", async () => {
      const mockDb = createMockDb();
      const deps: SDKAgentDeps = {
        db: mockDb,
      };

      // Set up SDK mock to return something
      setMockQueryResponse([
        {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "Acknowledged" }],
          },
        },
      ]);

      const agent = createSDKAgent(deps);
      const session = createMockSession();

      async function* inputMessages() {
        yield {
          type: "observation" as const,
          data: {
            observation: {
              toolName: "Read",
              toolInput: {},
              toolResponse: {},
              cwd: "/test",
              occurredAt: new Date().toISOString(),
            },
          },
        };
      }

      // Consume the generator to trigger the SDK call
      for await (const _ of agent.processMessages(session, inputMessages())) {
        // consume
      }

      // Verify SDK query was called with options
      const options = getLastQueryOptions();
      expect(options).not.toBeNull();

      // The pathToClaudeCodeExecutable should be set if Claude is found on the system
      // In CI/test environments it might not be found, so we check both cases
      if (options?.pathToClaudeCodeExecutable) {
        expect(typeof options.pathToClaudeCodeExecutable).toBe("string");
        expect(
          (options.pathToClaudeCodeExecutable as string).length,
        ).toBeGreaterThan(0);
      }

      // Always verify other required options are present
      expect(options?.model).toBe("claude-haiku-4-5");
      expect(options?.permissionMode).toBe("bypassPermissions");
      expect(options?.allowDangerouslySkipPermissions).toBe(true);
    });

    it("includes correct SDK options for observer mode", async () => {
      const mockDb = createMockDb();
      const deps: SDKAgentDeps = {
        db: mockDb,
      };

      setMockQueryResponse([
        {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "Acknowledged" }],
          },
        },
      ]);

      const agent = createSDKAgent(deps);
      const session = createMockSession();

      async function* inputMessages() {
        yield {
          type: "observation" as const,
          data: {
            observation: {
              toolName: "Read",
              toolInput: {},
              toolResponse: {},
              cwd: "/test",
              occurredAt: new Date().toISOString(),
            },
          },
        };
      }

      for await (const _ of agent.processMessages(session, inputMessages())) {
        // consume
      }

      const options = getLastQueryOptions();
      expect(options).not.toBeNull();

      // Verify observer mode settings
      expect(options?.tools).toEqual([]);
      expect(Array.isArray(options?.disallowedTools)).toBe(true);
      expect((options?.disallowedTools as string[]).length).toBeGreaterThan(0);

      // Verify system prompt is set
      expect(options?.systemPrompt).toBeDefined();
      expect(typeof options?.systemPrompt).toBe("string");
      expect((options?.systemPrompt as string).length).toBeGreaterThan(100);
    });

    it("includes debugging-related guidance in system prompt", async () => {
      const mockDb = createMockDb();
      const deps: SDKAgentDeps = {
        db: mockDb,
      };

      setMockQueryResponse([
        {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "Acknowledged" }],
          },
        },
      ]);

      const agent = createSDKAgent(deps);
      const session = createMockSession();

      async function* inputMessages() {
        yield {
          type: "observation" as const,
          data: {
            observation: {
              toolName: "Read",
              toolInput: {},
              toolResponse: {},
              cwd: "/test",
              occurredAt: new Date().toISOString(),
            },
          },
        };
      }

      for await (const _ of agent.processMessages(session, inputMessages())) {
        // consume
      }

      const options = getLastQueryOptions();
      const systemPrompt = options?.systemPrompt as string;

      // Verify the system prompt includes debugging guidance
      expect(systemPrompt).toContain("Bug investigations");
      expect(systemPrompt).toContain("root cause");
      expect(systemPrompt).toContain("debugging");
      expect(systemPrompt).toContain("INVESTIGATED");
      expect(systemPrompt).toContain("DEBUGGED");
    });
  });
});
