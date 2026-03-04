import { beforeEach, describe, expect, it, mock } from "bun:test";
import { DEFAULT_WORKER_PORT, serverUrl } from "../../src/constants";
import {
  formatSystemMessage,
  type HookDeps,
  processCleanupHook,
  processSummaryHook,
} from "../../src/hooks/logic";
import type { SessionEndInput, StopInput } from "../../src/types/hooks";

describe("hook logic — summary & cleanup", () => {
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
      expect(url).toBe(`${serverUrl(DEFAULT_WORKER_PORT)}/summary`);
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
      expect(url).toBe(`${serverUrl(DEFAULT_WORKER_PORT)}/complete`);
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
        "[goldfish] 12 memories loaded (3 decisions, 5 features, 2 bugfixes, 2 discoveries) + 3 session summaries",
      );
    });

    it("formats clear source with prefix", () => {
      const result = formatSystemMessage("clear", 5, 0, {
        feature: 3,
        bugfix: 2,
      });
      expect(result).toBe(
        "[goldfish] Fresh session \u2014 5 memories loaded (3 features, 2 bugfixes)",
      );
    });

    it("formats resume source with prefix", () => {
      const result = formatSystemMessage("resume", 5, 0, {
        feature: 5,
      });
      expect(result).toBe(
        "[goldfish] Resumed \u2014 5 memories loaded (5 features)",
      );
    });

    it("formats compact source with prefix", () => {
      const result = formatSystemMessage("compact", 3, 1, {
        decision: 3,
      });
      expect(result).toBe(
        "[goldfish] Compacted \u2014 3 memories loaded (3 decisions) + 1 session summary",
      );
    });

    it("omits zero-count types", () => {
      const result = formatSystemMessage("startup", 2, 0, {
        decision: 0,
        feature: 2,
        bugfix: 0,
      });
      expect(result).toBe("[goldfish] 2 memories loaded (2 features)");
    });

    it("handles no observations", () => {
      const result = formatSystemMessage("startup", 0, 0, {});
      expect(result).toBe("[goldfish] No previous context for this project");
    });

    it("handles no observations but has summaries", () => {
      const result = formatSystemMessage("startup", 0, 2, {});
      expect(result).toBe("[goldfish] 2 session summaries loaded");
    });

    it("uses singular 'summary' for count of 1", () => {
      const result = formatSystemMessage("startup", 3, 1, {
        feature: 3,
      });
      expect(result).toBe(
        "[goldfish] 3 memories loaded (3 features) + 1 session summary",
      );
    });

    it("defaults to startup when source is undefined", () => {
      const result = formatSystemMessage(undefined, 5, 0, {
        feature: 5,
      });
      expect(result).toBe("[goldfish] 5 memories loaded (5 features)");
    });
  });
});
