import { beforeEach, describe, expect, it, mock } from "bun:test";
import { DEFAULT_WORKER_PORT, serverUrl } from "../../src/constants";
import { type HookDeps, processContextHook } from "../../src/hooks/logic";
import type { SessionStartInput } from "../../src/types/hooks";

describe("hook logic — context", () => {
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
});
