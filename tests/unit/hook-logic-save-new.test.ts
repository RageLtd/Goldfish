import { beforeEach, describe, expect, it, mock } from "bun:test";
import { DEFAULT_WORKER_PORT, serverUrl } from "../../src/constants";
import {
  type HookDeps,
  processNewHook,
  processSaveHook,
} from "../../src/hooks/logic";
import type {
  PostToolUseInput,
  UserPromptSubmitInput,
} from "../../src/types/hooks";

describe("hook logic — save & new", () => {
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
      workerUrl: serverUrl(DEFAULT_WORKER_PORT),
    };
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
      expect(url).toBe(`${serverUrl(DEFAULT_WORKER_PORT)}/observation`);
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
    it("strips private tags from prompt before retrieval", async () => {
      mockFetch.mockImplementation(() =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              context: null,
              observationCount: 0,
              typeCounts: {},
            }),
        }),
      );

      const input: UserPromptSubmitInput = {
        session_id: "session-123",
        cwd: "/projects/test",
        prompt: "Help me <private>with secret stuff</private> fix a bug",
      };

      const result = await processNewHook(deps, input);

      expect(result.continue).toBe(true);

      // Check the retrieve call has private content stripped
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
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("calls /retrieve for substantive prompts", async () => {
      mockFetch.mockImplementation(() =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              context: "# relevant memories",
              observationCount: 3,
              typeCounts: { feature: 2, bugfix: 1 },
            }),
        }),
      );

      const input: UserPromptSubmitInput = {
        session_id: "session-123",
        cwd: "/projects/test",
        prompt: "Fix the authentication bug in login flow",
      };

      const result = await processNewHook(deps, input);

      expect(result.continue).toBe(true);
      const urls = mockFetch.mock.calls.map(
        (call: unknown[]) => call[0] as string,
      );
      expect(urls.some((u: string) => u.includes("/retrieve"))).toBe(true);
    });

    it("returns context when /retrieve finds relevant memories", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("/retrieve")) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                context: "# test memories\n\n| ID | Time | ...",
                observationCount: 5,
                typeCounts: { decision: 2, feature: 3 },
              }),
          });
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ status: "stored" }),
        });
      });

      const input: UserPromptSubmitInput = {
        session_id: "session-123",
        cwd: "/projects/test",
        prompt: "Refactor the database layer",
      };

      const result = await processNewHook(deps, input);

      expect(result.continue).toBe(true);
      expect(result.hookSpecificOutput?.additionalContext).toContain(
        "test memories",
      );
      expect(result.systemMessage).toContain("5 relevant memories");
      expect(result.hookSpecificOutput?.hookEventName).toBe("UserPromptSubmit");
    });

    it("returns success when /retrieve finds no results", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("/retrieve")) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                context: null,
                observationCount: 0,
                typeCounts: {},
              }),
          });
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ status: "stored" }),
        });
      });

      const input: UserPromptSubmitInput = {
        session_id: "session-123",
        cwd: "/projects/test",
        prompt: "Hello, how are you?",
      };

      const result = await processNewHook(deps, input);

      expect(result.continue).toBe(true);
      expect(result.suppressOutput).toBe(true);
      expect(result.hookSpecificOutput).toBeUndefined();
    });

    it("returns success when /retrieve errors", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("/retrieve")) {
          return Promise.reject(new Error("Model unavailable"));
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ status: "stored" }),
        });
      });

      const input: UserPromptSubmitInput = {
        session_id: "session-123",
        cwd: "/projects/test",
        prompt: "Fix the auth bug",
      };

      const result = await processNewHook(deps, input);

      // Should not crash, just return success without context
      expect(result.continue).toBe(true);
      expect(result.suppressOutput).toBe(true);
    });

    it("skips all network calls for low-signal prompts", async () => {
      const input: UserPromptSubmitInput = {
        session_id: "session-123",
        cwd: "/projects/test",
        prompt: "sounds good",
      };

      const result = await processNewHook(deps, input);

      expect(result.continue).toBe(true);
      expect(result.suppressOutput).toBe(true);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("skips all network calls for 'yes' with punctuation", async () => {
      const input: UserPromptSubmitInput = {
        session_id: "session-123",
        cwd: "/projects/test",
        prompt: "Yes!",
      };

      const result = await processNewHook(deps, input);

      expect(result.continue).toBe(true);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("retrieves for substantive short prompts", async () => {
      mockFetch.mockImplementation(() =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              context: null,
              observationCount: 0,
              typeCounts: {},
            }),
        }),
      );

      const input: UserPromptSubmitInput = {
        session_id: "session-123",
        cwd: "/projects/test",
        prompt: "fix the bug",
      };

      await processNewHook(deps, input);

      const urls = mockFetch.mock.calls.map(
        (call: unknown[]) => call[0] as string,
      );
      expect(urls.some((u: string) => u.includes("/retrieve"))).toBe(true);
    });

    it("passes session_id to /retrieve for first-prompt detection", async () => {
      mockFetch.mockImplementation(() =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              context: null,
              observationCount: 0,
              typeCounts: {},
            }),
        }),
      );

      const input: UserPromptSubmitInput = {
        session_id: "session-456",
        cwd: "/projects/test",
        prompt: "refactor the database layer",
      };

      await processNewHook(deps, input);

      const retrieveCall = mockFetch.mock.calls.find((call: unknown[]) =>
        (call[0] as string).includes("/retrieve"),
      );
      expect(retrieveCall).toBeDefined();
      const options = (retrieveCall as unknown[])[1] as RequestInit;
      const body = JSON.parse(options.body as string);
      expect(body.sessionId).toBe("session-456");
    });

    it("skips retrieval and storage for entirely private prompts", async () => {
      const input: UserPromptSubmitInput = {
        session_id: "session-123",
        cwd: "/projects/test",
        prompt: "<private>Secret internal discussion</private>",
      };

      const result = await processNewHook(deps, input);

      expect(result.continue).toBe(true);
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });
});
