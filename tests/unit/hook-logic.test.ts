import { beforeEach, describe, expect, it, mock } from "bun:test";
import {
  formatSystemMessage,
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
    it("fetches context and returns additionalContext with type breakdown", async () => {
      mockFetch.mockImplementation(() =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              context: "## Previous work\n- Did stuff",
              observationCount: 5,
              summaryCount: 2,
              typeCounts: { decision: 2, feature: 3 },
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
      expect(result.systemMessage).toContain("5 memories loaded");
      expect(result.systemMessage).toContain("2 decisions");
      expect(result.systemMessage).toContain("3 features");
      expect(result.systemMessage).toContain("2 session summaries");
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("includes type counts in system message", async () => {
      mockFetch.mockImplementation(() =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              context: "# test context\n\nSome observations",
              observationCount: 5,
              summaryCount: 2,
              typeCounts: { decision: 2, feature: 3 },
            }),
        }),
      );

      const input: SessionStartInput = {
        session_id: "session-123",
        cwd: "/projects/test",
        source: "startup",
      };

      const result = await processContextHook(deps, input);

      expect(result.systemMessage).toContain("5 memories loaded");
      expect(result.systemMessage).toContain("2 decisions");
      expect(result.systemMessage).toContain("3 features");
      expect(result.systemMessage).toContain("2 session summaries");
    });

    it("uses source-aware prefix for clear", async () => {
      mockFetch.mockImplementation(() =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              context: "# test context\n\nSome observations",
              observationCount: 3,
              summaryCount: 0,
              typeCounts: { feature: 3 },
            }),
        }),
      );

      const input: SessionStartInput = {
        session_id: "session-123",
        cwd: "/projects/test",
        source: "clear",
      };

      const result = await processContextHook(deps, input);

      expect(result.systemMessage).toContain("Fresh session");
      expect(result.systemMessage).toContain("3 memories loaded");
    });

    it("uses source-aware prefix for resume", async () => {
      mockFetch.mockImplementation(() =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              context: "# test context\n\nSome observations",
              observationCount: 4,
              summaryCount: 1,
              typeCounts: { decision: 2, bugfix: 2 },
            }),
        }),
      );

      const input: SessionStartInput = {
        session_id: "session-123",
        cwd: "/projects/test",
        source: "resume",
      };

      const result = await processContextHook(deps, input);

      expect(result.systemMessage).toContain("Resumed");
      expect(result.systemMessage).toContain("4 memories loaded");
      expect(result.systemMessage).toContain("2 decisions");
      expect(result.systemMessage).toContain("2 bugfixes");
      expect(result.systemMessage).toContain("1 session summary");
    });

    it("uses source-aware prefix for compact", async () => {
      mockFetch.mockImplementation(() =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              context: "# test context\n\nSome observations",
              observationCount: 7,
              summaryCount: 0,
              typeCounts: { feature: 4, refactor: 3 },
            }),
        }),
      );

      const input: SessionStartInput = {
        session_id: "session-123",
        cwd: "/projects/test",
        source: "compact",
      };

      const result = await processContextHook(deps, input);

      expect(result.systemMessage).toContain("Compacted");
      expect(result.systemMessage).toContain("7 memories loaded");
      expect(result.systemMessage).toContain("4 features");
      expect(result.systemMessage).toContain("3 refactors");
    });

    it("shows no-context message when no observations", async () => {
      mockFetch.mockImplementation(() =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              context: "# test recent context\n\nNo previous sessions found.",
              observationCount: 0,
              summaryCount: 0,
              typeCounts: {},
            }),
        }),
      );

      const input: SessionStartInput = {
        session_id: "session-123",
        cwd: "/projects/test",
        source: "startup",
      };

      const result = await processContextHook(deps, input);

      expect(result.systemMessage).toContain("No previous context");
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

  describe("processSaveHook tool filtering", () => {
    it("skips TodoRead tool", async () => {
      const input: PostToolUseInput = {
        session_id: "session-123",
        cwd: "/projects/test",
        tool_name: "TodoRead",
        tool_input: {},
        tool_response: "some todos",
      };
      const result = await processSaveHook(deps, input);
      expect(result.continue).toBe(true);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("skips TodoWrite tool", async () => {
      const input: PostToolUseInput = {
        session_id: "session-123",
        cwd: "/projects/test",
        tool_name: "TodoWrite",
        tool_input: {},
        tool_response: "ok",
      };
      const result = await processSaveHook(deps, input);
      expect(result.continue).toBe(true);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("skips LS tool", async () => {
      const input: PostToolUseInput = {
        session_id: "session-123",
        cwd: "/projects/test",
        tool_name: "LS",
        tool_input: {},
        tool_response: "file1.ts\nfile2.ts",
      };
      const result = await processSaveHook(deps, input);
      expect(result.continue).toBe(true);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("skips observations with tiny combined text (<50 chars)", async () => {
      const input: PostToolUseInput = {
        session_id: "session-123",
        cwd: "/projects/test",
        tool_name: "Read",
        tool_input: "a",
        tool_response: "",
      };
      const result = await processSaveHook(deps, input);
      expect(result.continue).toBe(true);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("allows Read tool with substantial content", async () => {
      const input: PostToolUseInput = {
        session_id: "session-123",
        cwd: "/projects/test",
        tool_name: "Read",
        tool_input: JSON.stringify({ file_path: "/projects/test/src/app.ts" }),
        tool_response:
          "const app = express(); // ... lots of code here that is substantial enough ...",
      };
      const result = await processSaveHook(deps, input);
      expect(result.continue).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(1);
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

  describe("processSummaryHook message extraction", () => {
    it("passes transcript_path to worker", async () => {
      const input: StopInput = {
        session_id: "session-123",
        cwd: "/projects/test",
        transcript_path: "/tmp/transcript.jsonl",
      };

      await processSummaryHook(deps, input);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const callArgs = mockFetch.mock.calls[0];
      const body = JSON.parse(callArgs[1].body);
      expect(body.claudeSessionId).toBe("session-123");
      expect(body).toHaveProperty("transcriptPath");
      expect(body.transcriptPath).toBe("/tmp/transcript.jsonl");
    });

    it("sends empty transcriptPath when not provided", async () => {
      const input: StopInput = {
        session_id: "session-123",
        cwd: "/projects/test",
      };

      await processSummaryHook(deps, input);

      const callArgs = mockFetch.mock.calls[0];
      const body = JSON.parse(callArgs[1].body);
      expect(body.transcriptPath).toBe("");
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

  describe("formatSystemMessage", () => {
    it("formats startup with type counts", () => {
      const result = formatSystemMessage("startup", 12, 3, {
        decision: 3,
        feature: 5,
        bugfix: 2,
        discovery: 2,
      });
      expect(result).toBe(
        "[claude-mem] 12 memories loaded (3 decisions, 5 features, 2 bugfixes, 2 discoveries) + 3 session summaries",
      );
    });

    it("formats clear source with prefix", () => {
      const result = formatSystemMessage("clear", 5, 0, {
        feature: 3,
        bugfix: 2,
      });
      expect(result).toBe(
        "[claude-mem] Fresh session \u2014 5 memories loaded (3 features, 2 bugfixes)",
      );
    });

    it("formats resume source with prefix", () => {
      const result = formatSystemMessage("resume", 5, 0, {
        feature: 5,
      });
      expect(result).toBe(
        "[claude-mem] Resumed \u2014 5 memories loaded (5 features)",
      );
    });

    it("formats compact source with prefix", () => {
      const result = formatSystemMessage("compact", 3, 1, {
        decision: 3,
      });
      expect(result).toBe(
        "[claude-mem] Compacted \u2014 3 memories loaded (3 decisions) + 1 session summary",
      );
    });

    it("omits zero-count types", () => {
      const result = formatSystemMessage("startup", 2, 0, {
        decision: 0,
        feature: 2,
        bugfix: 0,
      });
      expect(result).toBe("[claude-mem] 2 memories loaded (2 features)");
    });

    it("handles no observations", () => {
      const result = formatSystemMessage("startup", 0, 0, {});
      expect(result).toBe("[claude-mem] No previous context for this project");
    });

    it("handles no observations but has summaries", () => {
      const result = formatSystemMessage("startup", 0, 2, {});
      expect(result).toBe("[claude-mem] 2 session summaries loaded");
    });

    it("uses singular 'summary' for count of 1", () => {
      const result = formatSystemMessage("startup", 3, 1, {
        feature: 3,
      });
      expect(result).toBe(
        "[claude-mem] 3 memories loaded (3 features) + 1 session summary",
      );
    });

    it("defaults to startup when source is undefined", () => {
      const result = formatSystemMessage(undefined, 5, 0, {
        feature: 5,
      });
      expect(result).toBe("[claude-mem] 5 memories loaded (5 features)");
    });
  });
});
