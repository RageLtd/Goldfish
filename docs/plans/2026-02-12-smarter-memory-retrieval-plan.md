# Smarter Memory Retrieval Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Reduce memory noise, add relevance-scored retrieval with cross-project context, and fix summary extraction.

**Architecture:** Six independent improvements layered bottom-up: tool filtering and smarter project ID (hook layer), observation batching (session manager), summary hook fix (hook logic), relevance scoring with cross-project support (new module + handler + DB), and observation deduplication (SDK agent).

**Tech Stack:** Bun + TypeScript, bun:sqlite (FTS5), bun:test, existing Result pattern

---

### Task 1: Relevance Scoring Module — Pure Functions

**Files:**
- Create: `src/utils/relevance.ts`
- Test: `tests/unit/relevance.test.ts`

**Step 1: Write the failing tests**

Create `tests/unit/relevance.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import {
  calculateRecencyScore,
  calculateTypeScore,
  calculateSimilarityScore,
  calculateFileOverlapScore,
  scoreObservation,
  DEFAULT_SCORING_CONFIG,
  type ScoringConfig,
  type ScoringContext,
} from "../../src/utils/relevance";

describe("calculateRecencyScore", () => {
  it("returns 1.0 for observations created right now", () => {
    const now = Date.now();
    expect(calculateRecencyScore(now, 2)).toBeCloseTo(1.0, 2);
  });

  it("returns ~0.5 after one half-life", () => {
    const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000;
    expect(calculateRecencyScore(twoDaysAgo, 2)).toBeCloseTo(0.5, 1);
  });

  it("returns ~0.25 after two half-lives", () => {
    const fourDaysAgo = Date.now() - 4 * 24 * 60 * 60 * 1000;
    expect(calculateRecencyScore(fourDaysAgo, 2)).toBeCloseTo(0.25, 1);
  });

  it("approaches 0 for very old observations", () => {
    const monthAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    expect(calculateRecencyScore(monthAgo, 2)).toBeLessThan(0.01);
  });

  it("uses custom half-life", () => {
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    expect(calculateRecencyScore(sevenDaysAgo, 7)).toBeCloseTo(0.5, 1);
  });
});

describe("calculateTypeScore", () => {
  it("scores decision highest", () => {
    expect(calculateTypeScore("decision")).toBe(0.8);
  });

  it("scores bugfix high", () => {
    expect(calculateTypeScore("bugfix")).toBe(0.7);
  });

  it("scores discovery medium-high", () => {
    expect(calculateTypeScore("discovery")).toBe(0.6);
  });

  it("scores feature medium", () => {
    expect(calculateTypeScore("feature")).toBe(0.5);
  });

  it("scores refactor low-medium", () => {
    expect(calculateTypeScore("refactor")).toBe(0.4);
  });

  it("scores change lowest", () => {
    expect(calculateTypeScore("change")).toBe(0.3);
  });

  it("returns 0.3 for unknown types", () => {
    expect(calculateTypeScore("unknown")).toBe(0.3);
  });
});

describe("calculateSimilarityScore", () => {
  it("returns 0 when no FTS rank and no concept overlap", () => {
    expect(calculateSimilarityScore(0, 0)).toBe(0);
  });

  it("returns up to 1.5 with perfect match", () => {
    expect(calculateSimilarityScore(1.0, 1.0)).toBeCloseTo(1.5, 1);
  });

  it("weighs FTS rank more heavily than concept overlap", () => {
    const ftsOnly = calculateSimilarityScore(1.0, 0);
    const conceptOnly = calculateSimilarityScore(0, 1.0);
    expect(ftsOnly).toBeGreaterThan(conceptOnly);
  });
});

describe("calculateFileOverlapScore", () => {
  it("returns 0 when no overlap", () => {
    expect(calculateFileOverlapScore(["a.ts", "b.ts"], ["c.ts", "d.ts"])).toBe(0);
  });

  it("returns 1.0 for full overlap", () => {
    expect(calculateFileOverlapScore(["a.ts", "b.ts"], ["a.ts", "b.ts"])).toBe(1.0);
  });

  it("returns 0.5 for half overlap", () => {
    expect(calculateFileOverlapScore(["a.ts", "b.ts"], ["a.ts", "c.ts"])).toBe(0.5);
  });

  it("returns 0 when observation has no files", () => {
    expect(calculateFileOverlapScore([], ["a.ts"])).toBe(0);
  });

  it("returns 0 when cwd has no files", () => {
    expect(calculateFileOverlapScore(["a.ts"], [])).toBe(0);
  });

  it("matches partial file paths", () => {
    expect(
      calculateFileOverlapScore(
        ["src/utils/validation.ts"],
        ["src/utils/validation.ts", "src/hooks/logic.ts"],
      ),
    ).toBe(1.0);
  });
});

describe("scoreObservation", () => {
  const makeContext = (overrides?: Partial<ScoringContext>): ScoringContext => ({
    currentProject: "my-project",
    cwdFiles: [],
    ftsRanks: new Map(),
    ...overrides,
  });

  const makeObs = (overrides?: Record<string, unknown>) => ({
    id: 1,
    sdkSessionId: "sess-1",
    project: "my-project",
    type: "discovery" as const,
    title: "Test observation",
    subtitle: null,
    narrative: null,
    facts: [] as readonly string[],
    concepts: [] as readonly string[],
    filesRead: [] as readonly string[],
    filesModified: [] as readonly string[],
    promptNumber: 1,
    discoveryTokens: 0,
    createdAt: new Date().toISOString(),
    createdAtEpoch: Date.now(),
    ...overrides,
  });

  it("gives same-project bonus to current project observations", () => {
    const ctx = makeContext({ currentProject: "my-project" });
    const sameProject = scoreObservation(makeObs({ project: "my-project" }), ctx);
    const otherProject = scoreObservation(makeObs({ project: "other" }), ctx);
    expect(sameProject).toBeGreaterThan(otherProject);
  });

  it("lets high FTS rank override project bonus", () => {
    const ctx = makeContext({
      currentProject: "my-project",
      ftsRanks: new Map([[2, 1.0]]),
    });
    const highRankOther = scoreObservation(
      makeObs({ id: 2, project: "other" }),
      ctx,
    );
    const noRankSame = scoreObservation(
      makeObs({ id: 1, project: "my-project" }),
      ctx,
    );
    expect(highRankOther).toBeGreaterThan(noRankSame);
  });

  it("recency dominates for recent observations with no other signals", () => {
    const ctx = makeContext();
    const recent = scoreObservation(
      makeObs({ createdAtEpoch: Date.now() }),
      ctx,
    );
    const old = scoreObservation(
      makeObs({ createdAtEpoch: Date.now() - 7 * 24 * 60 * 60 * 1000 }),
      ctx,
    );
    expect(recent).toBeGreaterThan(old);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test tests/unit/relevance.test.ts`
Expected: FAIL — module `../../src/utils/relevance` does not exist

**Step 3: Write minimal implementation**

Create `src/utils/relevance.ts`:

```typescript
/**
 * Relevance scoring for memory retrieval.
 * Pure functions that score observations based on multiple factors.
 */

import type { Observation, ObservationType } from "../types/domain";

// ============================================================================
// Types
// ============================================================================

export interface ScoringConfig {
  readonly recencyHalfLifeDays: number;
  readonly sameProjectBonus: number;
  readonly ftsWeight: number;
  readonly conceptWeight: number;
}

export const DEFAULT_SCORING_CONFIG: ScoringConfig = {
  recencyHalfLifeDays: 2,
  sameProjectBonus: 0.1,
  ftsWeight: 1.0,
  conceptWeight: 0.5,
};

export interface ScoringContext {
  readonly currentProject: string;
  readonly cwdFiles: readonly string[];
  readonly ftsRanks: Map<number, number>;
  readonly config?: ScoringConfig;
}

// ============================================================================
// Individual Scoring Functions
// ============================================================================

const LN2 = 0.693;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Exponential decay based on age.
 * Returns 1.0 for now, 0.5 after one half-life, approaching 0 over time.
 */
export const calculateRecencyScore = (
  epochMs: number,
  halfLifeDays: number,
): number => {
  const ageDays = (Date.now() - epochMs) / MS_PER_DAY;
  return Math.exp(-LN2 * ageDays / halfLifeDays);
};

const TYPE_SCORES: Record<string, number> = {
  decision: 0.8,
  bugfix: 0.7,
  discovery: 0.6,
  feature: 0.5,
  refactor: 0.4,
  change: 0.3,
};

/**
 * Returns importance score based on observation type.
 */
export const calculateTypeScore = (type: string): number => {
  return TYPE_SCORES[type] ?? 0.3;
};

/**
 * Combines FTS5 rank and concept overlap into a similarity score (0–1.5).
 * FTS rank is weighted more heavily than concept overlap.
 */
export const calculateSimilarityScore = (
  normalizedFtsRank: number,
  conceptOverlap: number,
): number => {
  // ftsWeight=1.0, conceptWeight=0.5 → max = 1.0 + 0.5 = 1.5
  return normalizedFtsRank * 1.0 + conceptOverlap * 0.5;
};

/**
 * Calculates proportion of observation files found in cwd file set.
 */
export const calculateFileOverlapScore = (
  obsFiles: readonly string[],
  cwdFiles: readonly string[],
): number => {
  if (obsFiles.length === 0 || cwdFiles.length === 0) return 0;

  const cwdSet = new Set(cwdFiles);
  let matches = 0;
  for (const f of obsFiles) {
    if (cwdSet.has(f)) matches++;
  }
  return matches / obsFiles.length;
};

// ============================================================================
// Combined Scoring
// ============================================================================

/**
 * Scores a single observation against the current context.
 *
 * Formula:
 *   score = recencyScore(0-1.0)
 *         + typeScore(0.3-0.8)
 *         + similarityScore(0-1.5)
 *         + fileOverlapScore(0-1.0)
 *         + currentProjectBonus(0.1)
 */
export const scoreObservation = (
  observation: Observation,
  context: ScoringContext,
): number => {
  const config = context.config ?? DEFAULT_SCORING_CONFIG;

  const recency = calculateRecencyScore(
    observation.createdAtEpoch,
    config.recencyHalfLifeDays,
  );

  const typeImportance = calculateTypeScore(observation.type);

  const ftsRank = context.ftsRanks.get(observation.id) ?? 0;
  const similarity = calculateSimilarityScore(ftsRank, 0);

  const allFiles = [
    ...observation.filesRead,
    ...observation.filesModified,
  ];
  const fileOverlap = calculateFileOverlapScore(allFiles, context.cwdFiles);

  const projectBonus =
    observation.project === context.currentProject
      ? config.sameProjectBonus
      : 0;

  return recency + typeImportance + similarity + fileOverlap + projectBonus;
};
```

**Step 4: Run tests to verify they pass**

Run: `bun test tests/unit/relevance.test.ts`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add src/utils/relevance.ts tests/unit/relevance.test.ts
git commit -m "feat: add relevance scoring module with pure functions"
```

---

### Task 2: Tool Filtering in Save Hook

**Files:**
- Modify: `src/hooks/logic.ts:140-157`
- Test: `tests/unit/hook-logic.test.ts`

**Step 1: Write the failing tests**

Add to `tests/unit/hook-logic.test.ts`, inside the `describe("hook logic", ...)` block:

```typescript
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
      tool_response: "const app = express(); // ... lots of code here that is substantial enough ...",
    };

    const result = await processSaveHook(deps, input);
    expect(result.continue).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test tests/unit/hook-logic.test.ts`
Expected: FAIL — TodoRead, TodoWrite, LS still trigger fetch; tiny content still triggers fetch

**Step 3: Write minimal implementation**

In `src/hooks/logic.ts`, add constants and modify `processSaveHook`:

```typescript
// Add after the existing imports, before the Types section:

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_SKIP_TOOLS = ["TodoRead", "TodoWrite", "LS"];
const MIN_CONTENT_LENGTH = 50;

/**
 * Gets the skip tools list from environment or defaults.
 */
const getSkipTools = (): readonly string[] => {
  const envSkip = process.env.CLAUDE_MEM_SKIP_TOOLS;
  if (envSkip) {
    return envSkip.split(",").map((t) => t.trim());
  }
  return DEFAULT_SKIP_TOOLS;
};

/**
 * Extracts text length from tool input/response for size filtering.
 */
const getContentLength = (toolInput: unknown, toolResponse: unknown): number => {
  const inputStr = typeof toolInput === "string" ? toolInput : JSON.stringify(toolInput ?? "");
  const responseStr = typeof toolResponse === "string" ? toolResponse : JSON.stringify(toolResponse ?? "");
  return inputStr.length + responseStr.length;
};
```

Then replace the `processSaveHook` function body:

```typescript
export const processSaveHook = async (
  deps: HookDeps,
  input: PostToolUseInput,
): Promise<HookOutput> => {
  // Skip filtered tools
  const skipTools = getSkipTools();
  if (skipTools.includes(input.tool_name)) {
    return createSuccessOutput();
  }

  // Skip tiny observations
  if (getContentLength(input.tool_input, input.tool_response) < MIN_CONTENT_LENGTH) {
    return createSuccessOutput();
  }

  try {
    await postToWorker(deps, "/observation", {
      claudeSessionId: input.session_id,
      toolName: input.tool_name,
      toolInput: input.tool_input,
      toolResponse: sanitizeToolResponse(input.tool_response),
      cwd: input.cwd,
    });
  } catch {
    // Fire-and-forget: don't block Claude Code
  }

  return createSuccessOutput();
};
```

**Step 4: Run tests to verify they pass**

Run: `bun test tests/unit/hook-logic.test.ts`
Expected: All tests PASS

**Step 5: Run full test suite**

Run: `bun test`
Expected: All 256+ tests PASS (no regressions)

**Step 6: Commit**

```bash
git add src/hooks/logic.ts tests/unit/hook-logic.test.ts
git commit -m "feat: add tool filtering in save hook to reduce noise"
```

---

### Task 3: Fix Summary Hook — Pass Actual Messages

**Files:**
- Modify: `src/hooks/logic.ts:189-205`
- Modify: `src/types/hooks.ts:31-35` (if StopInput lacks fields)
- Test: `tests/unit/hook-logic.test.ts`

**Step 1: Write the failing tests**

Add to `tests/unit/hook-logic.test.ts`:

```typescript
describe("processSummaryHook message extraction", () => {
  it("passes last_user_message and last_assistant_message to worker", async () => {
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
    // After fix: these should no longer be empty strings
    // The hook should forward transcript_path so the worker can extract messages
    expect(body).toHaveProperty("transcriptPath");
    expect(body.transcriptPath).toBe("/tmp/transcript.jsonl");
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test tests/unit/hook-logic.test.ts`
Expected: FAIL — `transcriptPath` is not being sent (currently sends empty `lastUserMessage`/`lastAssistantMessage`)

**Step 3: Check StopInput type and update if needed**

The `StopInput` type in `src/types/hooks.ts:31-35` already has `transcript_path`. Verify the `QueueSummaryInput` type in `src/worker/handlers.ts` accepts `transcriptPath`. Add it:

In `src/worker/handlers.ts`, update `QueueSummaryInput`:

```typescript
export interface QueueSummaryInput {
  readonly claudeSessionId: string;
  readonly lastUserMessage: string;
  readonly lastAssistantMessage: string;
  readonly transcriptPath?: string;
}
```

In `src/hooks/logic.ts`, update `processSummaryHook`:

```typescript
export const processSummaryHook = async (
  deps: HookDeps,
  input: StopInput,
): Promise<HookOutput> => {
  try {
    await postToWorker(deps, "/summary", {
      claudeSessionId: input.session_id,
      transcriptPath: input.transcript_path || "",
      lastUserMessage: "",
      lastAssistantMessage: "",
    });
  } catch {
    // Fire-and-forget
  }

  return createSuccessOutput();
};
```

In `src/worker/service.ts`, update `handleSummaryRoute` to also forward `transcriptPath`:

```typescript
const result = await handleQueueSummary(deps, {
  claudeSessionId: body.claudeSessionId || "",
  lastUserMessage: body.lastUserMessage || "",
  lastAssistantMessage: body.lastAssistantMessage || "",
  transcriptPath: body.transcriptPath,
});
```

In `src/worker/handlers.ts`, update `handleQueueSummary` to store `transcriptPath`:

```typescript
// In handleQueueSummary, add transcriptPath logging
// and forward it to the session manager's queueSummarize
```

**Step 4: Run tests to verify they pass**

Run: `bun test tests/unit/hook-logic.test.ts`
Expected: All tests PASS

**Step 5: Run full test suite**

Run: `bun test`
Expected: All tests PASS

**Step 6: Commit**

```bash
git add src/hooks/logic.ts src/worker/handlers.ts src/worker/service.ts src/types/hooks.ts tests/unit/hook-logic.test.ts
git commit -m "fix: pass transcript_path through summary hook to worker"
```

---

### Task 4: Smarter Project Identification (Git Root)

**Files:**
- Modify: `src/utils/validation.ts:70-80`
- Test: `tests/unit/validation.test.ts`

**Step 1: Write the failing tests**

Add to `tests/unit/validation.test.ts`:

```typescript
import { describe, expect, it, mock, beforeEach, afterEach } from "bun:test";

describe("projectFromCwd — git-aware", () => {
  it("uses git repo root name for a repo directory", () => {
    // This test needs a real git repo. The test project itself is a git repo.
    // projectFromCwd should return the repo name, not the worktree dir name
    const cwd = process.cwd();
    const result = projectFromCwd(cwd);
    // Should be "claude-mem-bun" not "dreamy-neumann" (worktree dir)
    expect(result).toBe("claude-mem-bun");
  });

  it("falls back to basename for non-git directories", () => {
    expect(projectFromCwd("/tmp/some-random-dir")).toBe("some-random-dir");
  });

  it("handles git worktrees correctly", () => {
    // When run from a worktree, should resolve to main repo name
    // This is implicitly tested by the first test since we're in a worktree
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test tests/unit/validation.test.ts`
Expected: FAIL — `projectFromCwd(process.cwd())` returns `"dreamy-neumann"` not `"claude-mem-bun"`

**Step 3: Write minimal implementation**

In `src/utils/validation.ts`, replace `projectFromCwd`:

```typescript
import { execSync } from "node:child_process";

/**
 * Cache for git root lookups (cwd -> repo name).
 * Cached per-process lifetime to avoid repeated exec calls.
 */
const gitRootCache = new Map<string, string | null>();

/**
 * Attempts to get the git repository root name for a directory.
 * Returns null if the directory is not in a git repo.
 * For worktrees, follows to the main repo's root.
 */
const getGitRepoName = (cwd: string): string | null => {
  if (gitRootCache.has(cwd)) {
    return gitRootCache.get(cwd) ?? null;
  }

  try {
    // --show-toplevel gives the worktree root.
    // For the actual repo name, we need the common dir for worktrees.
    const commonDir = execSync("git rev-parse --git-common-dir", {
      cwd,
      encoding: "utf-8",
      timeout: 2000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    // commonDir is either ".git" (regular repo) or an absolute path like
    // "/path/to/repo/.git" (worktree). Resolve to the parent dir name.
    let repoRoot: string;
    if (commonDir === ".git") {
      // Regular repo — use toplevel
      repoRoot = execSync("git rev-parse --show-toplevel", {
        cwd,
        encoding: "utf-8",
        timeout: 2000,
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
    } else {
      // Worktree — commonDir points to main repo's .git dir
      // e.g., "/Users/foo/projects/claude-mem-bun/.git" -> "/Users/foo/projects/claude-mem-bun"
      repoRoot = commonDir.replace(/[/\\]\.git[/\\]?$/, "");
    }

    // Extract basename
    const parts = repoRoot.split(/[/\\]/);
    const name = parts[parts.length - 1] || null;
    const sanitized = name ? sanitizeProject(name) : null;
    const result = sanitized === "unknown" ? null : sanitized;

    gitRootCache.set(cwd, result);
    return result;
  } catch {
    gitRootCache.set(cwd, null);
    return null;
  }
};

/**
 * Extracts and sanitizes project name from a cwd path.
 * 1. Try git repo root name (handles worktrees correctly)
 * 2. Fall back to basename
 */
export const projectFromCwd = (cwd: string): string => {
  if (!cwd || typeof cwd !== "string") {
    return "unknown";
  }

  // Try git-based detection first
  const gitName = getGitRepoName(cwd);
  if (gitName) {
    return gitName;
  }

  // Fall back to basename
  const parts = cwd.split(/[/\\]/);
  const basename = parts[parts.length - 1] || "";
  return sanitizeProject(basename);
};
```

Note: Also export `getGitRepoName` for testing if desired, or test through `projectFromCwd`.

**Step 4: Run tests to verify they pass**

Run: `bun test tests/unit/validation.test.ts`
Expected: All tests PASS

**Step 5: Run full test suite**

Run: `bun test`
Expected: All tests PASS

**Step 6: Commit**

```bash
git add src/utils/validation.ts tests/unit/validation.test.ts
git commit -m "feat: use git repo root for project identification, handle worktrees"
```

---

### Task 5: Database Migration v5 — Cross-Project Indexes

**Files:**
- Modify: `src/db/migrations.ts`
- Test: `tests/unit/database.test.ts`

**Step 1: Write the failing test**

Add to `tests/unit/database.test.ts`:

```typescript
describe("migration v5 — cross-project indexes", () => {
  it("creates idx_observations_concepts index", () => {
    const row = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_observations_concepts'",
      )
      .get();
    expect(row).not.toBeNull();
    expect(row!.name).toBe("idx_observations_concepts");
  });

  it("creates idx_observations_project_epoch index", () => {
    const row = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_observations_project_epoch'",
      )
      .get();
    expect(row).not.toBeNull();
    expect(row!.name).toBe("idx_observations_project_epoch");
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test tests/unit/database.test.ts`
Expected: FAIL — indexes don't exist yet

**Step 3: Write minimal implementation**

Add to the `migrations` array in `src/db/migrations.ts`:

```typescript
{
  version: 5,
  description: "Add cross-project query indexes",
  up: (db) => {
    db.run(
      "CREATE INDEX IF NOT EXISTS idx_observations_concepts ON observations(concepts)",
    );
    db.run(
      "CREATE INDEX IF NOT EXISTS idx_observations_project_epoch ON observations(project, created_at_epoch DESC)",
    );
  },
},
```

**Step 4: Run tests to verify they pass**

Run: `bun test tests/unit/database.test.ts`
Expected: All tests PASS

**Step 5: Run full test suite**

Run: `bun test`
Expected: All tests PASS

**Step 6: Commit**

```bash
git add src/db/migrations.ts tests/unit/database.test.ts
git commit -m "feat: add migration v5 for cross-project query indexes"
```

---

### Task 6: Cross-Project DB Query Functions

**Files:**
- Modify: `src/db/index.ts`
- Test: `tests/unit/database.test.ts`

**Step 1: Write the failing tests**

Add to `tests/unit/database.test.ts`:

```typescript
describe("getCandidateObservations (cross-project)", () => {
  it("returns observations from all projects", () => {
    // Store observations in two different projects
    storeObservation(db, {
      claudeSessionId: "sess-1",
      project: "project-a",
      observation: {
        type: "bugfix",
        title: "Fix auth bug",
        subtitle: null,
        narrative: "Fixed authentication timeout",
        facts: [],
        concepts: ["problem-solution"],
        filesRead: ["src/auth.ts"],
        filesModified: ["src/auth.ts"],
      },
      promptNumber: 1,
    });

    storeObservation(db, {
      claudeSessionId: "sess-2",
      project: "project-b",
      observation: {
        type: "discovery",
        title: "Found config issue",
        subtitle: null,
        narrative: "Config parsing fails on empty",
        facts: [],
        concepts: ["gotcha"],
        filesRead: ["src/config.ts"],
        filesModified: [],
      },
      promptNumber: 1,
    });

    const result = getCandidateObservations(db, { limit: 10 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.length).toBe(2);
      const projects = result.value.map((o) => o.project);
      expect(projects).toContain("project-a");
      expect(projects).toContain("project-b");
    }
  });

  it("supports FTS keyword filtering", () => {
    const result = getCandidateObservations(db, {
      limit: 10,
      ftsQuery: '"auth"',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.length).toBeGreaterThanOrEqual(1);
      expect(result.value[0].title).toContain("auth");
    }
  });

  it("returns ftsRank when FTS query provided", () => {
    const result = getCandidateObservations(db, {
      limit: 10,
      ftsQuery: '"auth"',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // FTS results should have a rank
      expect(result.value[0]).toHaveProperty("ftsRank");
    }
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test tests/unit/database.test.ts`
Expected: FAIL — `getCandidateObservations` doesn't exist

**Step 3: Write minimal implementation**

Add to `src/db/index.ts`:

```typescript
// ============================================================================
// Cross-Project Candidate Retrieval
// ============================================================================

interface GetCandidateObservationsInput {
  readonly limit: number;
  readonly ftsQuery?: string;
}

export interface ObservationWithRank extends Observation {
  readonly ftsRank: number;
}

/**
 * Gets candidate observations across ALL projects for relevance scoring.
 * When ftsQuery is provided, uses FTS5 for keyword matching and returns rank.
 * When no ftsQuery, returns recent observations ordered by epoch.
 */
export const getCandidateObservations = (
  db: Database,
  input: GetCandidateObservationsInput,
): Result<readonly ObservationWithRank[]> => {
  const { limit, ftsQuery } = input;

  try {
    if (ftsQuery) {
      const sql = `
        SELECT o.*, fts.rank as fts_rank
        FROM observations o
        JOIN observations_fts fts ON o.id = fts.rowid
        WHERE observations_fts MATCH ?
        ORDER BY fts.rank
        LIMIT ?
      `;
      const rows = db
        .query<ObservationRow & { fts_rank: number }, [string, number]>(sql)
        .all(ftsQuery, limit);

      return ok(
        rows.map((row) => ({
          ...rowToObservation(row),
          ftsRank: row.fts_rank,
        })),
      );
    }

    // No FTS query — return recent from all projects
    const sql = `
      SELECT *, 0 as fts_rank FROM observations
      ORDER BY created_at_epoch DESC
      LIMIT ?
    `;
    const rows = db
      .query<ObservationRow & { fts_rank: number }, [number]>(sql)
      .all(limit);

    return ok(
      rows.map((row) => ({
        ...rowToObservation(row),
        ftsRank: 0,
      })),
    );
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }
};
```

**Step 4: Run tests to verify they pass**

Run: `bun test tests/unit/database.test.ts`
Expected: All tests PASS

**Step 5: Run full test suite**

Run: `bun test`
Expected: All tests PASS

**Step 6: Commit**

```bash
git add src/db/index.ts tests/unit/database.test.ts
git commit -m "feat: add cross-project candidate observation query"
```

---

### Task 7: Relevance-Scored Context Handler

**Files:**
- Modify: `src/worker/handlers.ts:454-518` (replace `handleGetContext`)
- Test: `tests/unit/worker-handlers.test.ts`

**Step 1: Write the failing tests**

Add to `tests/unit/worker-handlers.test.ts`:

```typescript
describe("handleGetContext — relevance scoring", () => {
  it("returns observations scored by relevance", async () => {
    // Store observations from two projects
    storeObservation(db, {
      claudeSessionId: "sess-1",
      project: "project-a",
      observation: {
        type: "bugfix",
        title: "Fix auth bug in login",
        subtitle: null,
        narrative: "Fixed authentication timeout in login handler",
        facts: [],
        concepts: ["problem-solution"],
        filesRead: ["src/auth.ts"],
        filesModified: ["src/auth.ts"],
      },
      promptNumber: 1,
    });

    storeObservation(db, {
      claudeSessionId: "sess-2",
      project: "project-b",
      observation: {
        type: "change",
        title: "Update readme",
        subtitle: null,
        narrative: "Updated README with install instructions",
        facts: [],
        concepts: ["what-changed"],
        filesRead: ["README.md"],
        filesModified: ["README.md"],
      },
      promptNumber: 1,
    });

    const result = await handleGetContext(deps, {
      project: "project-a",
      limit: 10,
      format: "index",
    });

    expect(result.status).toBe(200);
    // Both projects should be represented (cross-project)
    const body = result.body as { context: string; observationCount: number };
    expect(body.observationCount).toBeGreaterThanOrEqual(1);
  });

  it("attributes cross-project observations in formatted output", async () => {
    // Store observation from another project
    storeObservation(db, {
      claudeSessionId: "sess-other",
      project: "other-project",
      observation: {
        type: "bugfix",
        title: "Same bug fix",
        subtitle: null,
        narrative: "Fixed the same bug",
        facts: [],
        concepts: [],
        filesRead: [],
        filesModified: [],
      },
      promptNumber: 1,
    });

    const result = await handleGetContext(deps, {
      project: "my-project",
      limit: 50,
      format: "index",
    });

    expect(result.status).toBe(200);
    const body = result.body as { context: string };
    // Cross-project items should be labeled
    if (body.context.includes("Same bug fix")) {
      expect(body.context).toContain("[from: other-project]");
    }
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test tests/unit/worker-handlers.test.ts`
Expected: FAIL — cross-project observations not returned, no attribution labels

**Step 3: Write implementation**

In `src/worker/handlers.ts`, update imports and replace `handleGetContext`:

```typescript
// Add import
import { getCandidateObservations, type ObservationWithRank } from "../db/index";
import { scoreObservation, type ScoringContext } from "../utils/relevance";

export const handleGetContext = async (
  deps: WorkerDeps,
  input: GetContextInput,
): Promise<HandlerResponse> => {
  const { project, limit, format = "index", since } = input;

  const sinceEpoch = parseSince(since);

  // Get candidates from ALL projects (3x limit for re-ranking headroom)
  const candidateLimit = limit * 3;
  const candidatesResult = getCandidateObservations(deps.db, {
    limit: candidateLimit,
  });

  if (!candidatesResult.ok) {
    return {
      status: 500,
      body: { error: candidatesResult.error.message },
    };
  }

  let candidates = candidatesResult.value;

  // Filter by since if provided
  if (sinceEpoch !== null) {
    candidates = candidates.filter((o) => o.createdAtEpoch >= sinceEpoch);
  }

  // Build scoring context
  const ftsRanks = new Map<number, number>();
  for (const c of candidates) {
    if (c.ftsRank !== 0) {
      ftsRanks.set(c.id, Math.abs(c.ftsRank));
    }
  }

  const halfLifeDays = parseInt(
    process.env.CLAUDE_MEM_RECENCY_HALFLIFE_DAYS || "2",
    10,
  );
  const crossProjectEnabled =
    process.env.CLAUDE_MEM_CROSS_PROJECT !== "false";

  const scoringContext: ScoringContext = {
    currentProject: project,
    cwdFiles: [],
    ftsRanks,
    config: {
      recencyHalfLifeDays: Number.isNaN(halfLifeDays) ? 2 : halfLifeDays,
      sameProjectBonus: 0.1,
      ftsWeight: 1.0,
      conceptWeight: 0.5,
    },
  };

  // Score and sort
  const scored = candidates
    .filter((o) => crossProjectEnabled || o.project === project)
    .map((obs) => ({
      observation: obs as Observation,
      score: scoreObservation(obs, scoringContext),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  const observations = scored.map((s) => s.observation);

  // Get summaries (still project-scoped)
  const summariesResult = getRecentSummaries(deps.db, { project, limit });
  if (!summariesResult.ok) {
    return {
      status: 500,
      body: { error: summariesResult.error.message },
    };
  }

  let summaries = summariesResult.value;
  if (sinceEpoch !== null) {
    summaries = summaries.filter((s) => s.createdAtEpoch >= sinceEpoch);
  }

  if (observations.length === 0 && summaries.length === 0) {
    return {
      status: 200,
      body: {
        context: `# ${project} recent context\n\nNo previous sessions found for this project yet.`,
        observationCount: 0,
        summaryCount: 0,
        format,
      },
    };
  }

  const context =
    format === "index"
      ? formatContextIndex(project, observations, summaries)
      : formatContextFull(project, observations, summaries);

  return {
    status: 200,
    body: {
      context,
      observationCount: observations.length,
      summaryCount: summaries.length,
      format,
    },
  };
};
```

**Step 4: Update context formatter for cross-project attribution**

In `src/utils/context-formatter.ts`, modify `formatObservationIndexRow` to accept an optional project parameter:

```typescript
export const formatObservationIndexRow = (
  obs: Observation,
  currentProject?: string,
): string => {
  const icon = TYPE_ICONS[obs.type] || "\u{1F4DD}";
  const time = formatTime(obs.createdAtEpoch);
  const title = obs.title || "Untitled";
  const readTokens = estimateObservationTokens(obs);
  const workIcon = getWorkIcon(obs.type);
  const workTokens = obs.discoveryTokens || 0;
  const attribution =
    currentProject && obs.project !== currentProject
      ? ` [from: ${obs.project}]`
      : "";

  return `| #${obs.id} | ${time} | ${icon} | ${title}${attribution} | ~${readTokens} | ${workIcon} ${workTokens.toLocaleString()} |`;
};
```

And update `formatContextIndex` to pass the project through:

```typescript
// In the loop where formatObservationIndexRow is called:
parts.push(formatObservationIndexRow(obs, project));
```

**Step 5: Run tests to verify they pass**

Run: `bun test tests/unit/worker-handlers.test.ts`
Expected: All tests PASS

**Step 6: Run full test suite**

Run: `bun test`
Expected: All tests PASS

**Step 7: Commit**

```bash
git add src/worker/handlers.ts src/utils/context-formatter.ts tests/unit/worker-handlers.test.ts
git commit -m "feat: relevance-scored context retrieval with cross-project support"
```

---

### Task 8: Observation Deduplication in SDK Agent

**Files:**
- Modify: `src/worker/sdk-agent.ts:421-432`
- Modify: `src/db/index.ts` (add `findSimilarObservation`)
- Test: `tests/unit/database.test.ts`

**Step 1: Write the failing tests for the DB function**

Add to `tests/unit/database.test.ts`:

```typescript
describe("findSimilarObservation", () => {
  it("returns null when no similar observations exist", () => {
    const result = findSimilarObservation(db, {
      project: "test-project",
      title: "Completely unique title",
      withinMs: 3600000,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBeNull();
    }
  });

  it("finds similar observation within time window", () => {
    storeObservation(db, {
      claudeSessionId: "sess-1",
      project: "test-project",
      observation: {
        type: "discovery",
        title: "Database connection pooling exhausts connections",
        subtitle: null,
        narrative: "Found connection leak",
        facts: [],
        concepts: [],
        filesRead: [],
        filesModified: [],
      },
      promptNumber: 1,
    });

    const result = findSimilarObservation(db, {
      project: "test-project",
      title: "Database connection pooling exhausts connections due to missing cleanup",
      withinMs: 3600000,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).not.toBeNull();
    }
  });

  it("ignores observations from different projects", () => {
    const result = findSimilarObservation(db, {
      project: "different-project",
      title: "Database connection pooling exhausts connections",
      withinMs: 3600000,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBeNull();
    }
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test tests/unit/database.test.ts`
Expected: FAIL — `findSimilarObservation` doesn't exist

**Step 3: Implement the deduplication helper**

Add to `src/db/index.ts`:

```typescript
// ============================================================================
// Deduplication
// ============================================================================

interface FindSimilarInput {
  readonly project: string;
  readonly title: string;
  readonly withinMs: number;
}

/**
 * Jaccard similarity on word tokens.
 */
const jaccardSimilarity = (a: string, b: string): number => {
  const wordsA = new Set(a.toLowerCase().split(/\s+/));
  const wordsB = new Set(b.toLowerCase().split(/\s+/));
  if (wordsA.size === 0 && wordsB.size === 0) return 1;
  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let intersection = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection++;
  }
  const union = wordsA.size + wordsB.size - intersection;
  return union === 0 ? 0 : intersection / union;
};

/**
 * Finds a near-duplicate observation in the same project within a time window.
 * Returns the matching observation if Jaccard similarity > 0.8, null otherwise.
 */
export const findSimilarObservation = (
  db: Database,
  input: FindSimilarInput,
): Result<Observation | null> => {
  const { project, title, withinMs } = input;
  const cutoff = Date.now() - withinMs;

  try {
    const rows = db
      .query<ObservationRow, [string, number]>(
        `SELECT * FROM observations
         WHERE project = ? AND created_at_epoch > ?
         ORDER BY created_at_epoch DESC
         LIMIT 20`,
      )
      .all(project, cutoff);

    for (const row of rows) {
      if (row.title && jaccardSimilarity(title, row.title) > 0.8) {
        return ok(rowToObservation(row));
      }
    }

    return ok(null);
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }
};
```

**Step 4: Run DB tests to verify they pass**

Run: `bun test tests/unit/database.test.ts`
Expected: All tests PASS

**Step 5: Wire deduplication into SDK agent**

In `src/worker/sdk-agent.ts`, add the import and dedup check before storing:

```typescript
import { findSimilarObservation, storeObservation, storeSummary } from "../db/index";

// Inside processMessages, replace the storeObservation block:
for (const obs of observations) {
  // Deduplication check
  const dupCheck = findSimilarObservation(db, {
    project: session.project,
    title: obs.title || "",
    withinMs: 3600000, // 1 hour
  });

  if (dupCheck.ok && dupCheck.value) {
    log(`Skipping duplicate observation: "${obs.title}" (similar to #${dupCheck.value.id})`);
    yield { type: "acknowledged" };
    continue;
  }

  log(`Storing observation: type=${obs.type}, title=${obs.title}`);
  const result = storeObservation(db, {
    // ... existing store logic
  });
  // ... rest of existing store + yield logic
}
```

**Step 6: Run full test suite**

Run: `bun test`
Expected: All tests PASS

**Step 7: Commit**

```bash
git add src/db/index.ts src/worker/sdk-agent.ts tests/unit/database.test.ts
git commit -m "feat: observation deduplication with Jaccard similarity"
```

---

### Task 9: Observation Batching in SessionManager

**Files:**
- Modify: `src/worker/session-manager.ts`
- Test: `tests/unit/session-manager.test.ts`

**Step 1: Write the failing tests**

Add to `tests/unit/session-manager.test.ts`:

```typescript
import { describe, expect, it, beforeEach, afterEach } from "bun:test";

describe("observation batching", () => {
  it("merges consecutive observations of the same tool type within batch window", async () => {
    const sm = createSessionManager();
    const session = sm.initializeSession(1, "sess-1", "test", "prompt");

    // Queue two Read observations quickly
    sm.queueObservation(1, {
      toolName: "Read",
      toolInput: JSON.stringify({ file_path: "a.ts" }),
      toolResponse: "content of a",
      cwd: "/test",
      occurredAt: new Date().toISOString(),
    });

    sm.queueObservation(1, {
      toolName: "Read",
      toolInput: JSON.stringify({ file_path: "b.ts" }),
      toolResponse: "content of b",
      cwd: "/test",
      occurredAt: new Date().toISOString(),
    });

    // Wait for batch window to flush (3s + buffer)
    await new Promise((resolve) => setTimeout(resolve, 3500));

    // Get messages from iterator
    const iter = sm.getMessageIterator(1);
    expect(iter).not.toBeNull();

    // Should have merged into a single batched message
    const msg = await Promise.race([
      iter!.next(),
      new Promise<IteratorResult<unknown>>((resolve) =>
        setTimeout(() => resolve({ value: undefined, done: true }), 1000),
      ),
    ]);

    if (!msg.done) {
      const data = msg.value as { type: string; data: { observation: { toolName: string } } };
      expect(data.type).toBe("observation");
      // The merged observation should mention both files
      const input = JSON.stringify(data.data.observation.toolInput);
      expect(input).toContain("a.ts");
      expect(input).toContain("b.ts");
    }

    sm.closeSession(1);
  });

  it("does not batch observations of different tool types", async () => {
    const sm = createSessionManager();
    sm.initializeSession(1, "sess-1", "test", "prompt");

    sm.queueObservation(1, {
      toolName: "Read",
      toolInput: "read input",
      toolResponse: "read response with enough content to pass filter",
      cwd: "/test",
      occurredAt: new Date().toISOString(),
    });

    sm.queueObservation(1, {
      toolName: "Edit",
      toolInput: "edit input with enough content to pass the minimum filter",
      toolResponse: "edit response",
      cwd: "/test",
      occurredAt: new Date().toISOString(),
    });

    // Wait for batch window
    await new Promise((resolve) => setTimeout(resolve, 3500));

    const iter = sm.getMessageIterator(1);
    const msg1 = await Promise.race([
      iter!.next(),
      new Promise<IteratorResult<unknown>>((resolve) =>
        setTimeout(() => resolve({ value: undefined, done: true }), 1000),
      ),
    ]);
    const msg2 = await Promise.race([
      iter!.next(),
      new Promise<IteratorResult<unknown>>((resolve) =>
        setTimeout(() => resolve({ value: undefined, done: true }), 1000),
      ),
    ]);

    // Both should be separate messages
    expect(msg1.done).toBe(false);
    expect(msg2.done).toBe(false);

    sm.closeSession(1);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test tests/unit/session-manager.test.ts`
Expected: FAIL — no batching behavior, messages are forwarded immediately

**Step 3: Write implementation**

In `src/worker/session-manager.ts`, add batching logic to `queueObservation`. Add a batch buffer to `SessionState` and a flush timer:

```typescript
// Add to SessionState interface:
interface SessionState {
  readonly session: ActiveSession;
  readonly messageQueue: PendingMessage[];
  readonly waitingResolvers: Array<
    (value: IteratorResult<PendingMessage>) => void
  >;
  lastActivityAt: number;
  closed: boolean;
  // Batching state
  pendingBatch: ToolObservation[];
  batchToolName: string | null;
  batchTimer: ReturnType<typeof setTimeout> | null;
}
```

Update `initializeSession` to initialize batch fields:

```typescript
const state: SessionState = {
  session,
  messageQueue: [],
  waitingResolvers: [],
  lastActivityAt: Date.now(),
  closed: false,
  pendingBatch: [],
  batchToolName: null,
  batchTimer: null,
};
```

Replace `queueObservation`:

```typescript
const BATCH_WINDOW_MS = parseInt(
  process.env.CLAUDE_MEM_BATCH_WINDOW_MS || "3000",
  10,
);

const flushBatch = (sessionDbId: number): void => {
  const state = sessions.get(sessionDbId);
  if (!state || state.pendingBatch.length === 0) return;

  if (state.pendingBatch.length === 1) {
    // Single observation — send as-is
    enqueueMessage(sessionDbId, {
      type: "observation",
      data: { observation: state.pendingBatch[0] },
    });
  } else {
    // Merge batch into single observation
    const merged: ToolObservation = {
      toolName: state.batchToolName || state.pendingBatch[0].toolName,
      toolInput: state.pendingBatch.map((o) => o.toolInput),
      toolResponse: state.pendingBatch.map((o) => o.toolResponse),
      cwd: state.pendingBatch[0].cwd,
      occurredAt: state.pendingBatch[0].occurredAt,
    };
    enqueueMessage(sessionDbId, {
      type: "observation",
      data: { observation: merged },
    });
  }

  state.pendingBatch = [];
  state.batchToolName = null;
  state.batchTimer = null;
};

const queueObservation = (
  sessionDbId: number,
  observation: ToolObservation,
): boolean => {
  const state = sessions.get(sessionDbId);
  if (!state || state.closed) return false;

  state.lastActivityAt = Date.now();

  // Check if this can be added to the current batch
  if (
    state.batchToolName === observation.toolName &&
    state.pendingBatch.length > 0
  ) {
    // Same tool type — add to batch
    state.pendingBatch.push(observation);
    return true;
  }

  // Different tool type — flush existing batch first
  if (state.pendingBatch.length > 0) {
    if (state.batchTimer) clearTimeout(state.batchTimer);
    flushBatch(sessionDbId);
  }

  // Start new batch
  state.pendingBatch = [observation];
  state.batchToolName = observation.toolName;
  state.batchTimer = setTimeout(() => {
    flushBatch(sessionDbId);
  }, BATCH_WINDOW_MS);

  return true;
};
```

Also update `closeSession` to flush pending batches:

```typescript
const closeSession = (sessionDbId: number): boolean => {
  const state = sessions.get(sessionDbId);
  if (!state) return false;

  // Flush any pending batch
  if (state.batchTimer) clearTimeout(state.batchTimer);
  if (state.pendingBatch.length > 0) {
    flushBatch(sessionDbId);
  }

  state.closed = true;
  // ... rest of existing close logic
};
```

**Step 4: Run tests to verify they pass**

Run: `bun test tests/unit/session-manager.test.ts`
Expected: All tests PASS

**Step 5: Run full test suite**

Run: `bun test`
Expected: All tests PASS

**Step 6: Commit**

```bash
git add src/worker/session-manager.ts tests/unit/session-manager.test.ts
git commit -m "feat: observation batching in SessionManager with configurable window"
```

---

### Task 10: Cross-Project Attribution in Context Formatter

**Files:**
- Modify: `src/utils/context-formatter.ts`
- Test: `tests/unit/context-formatter.test.ts`

**Step 1: Write the failing tests**

Add to `tests/unit/context-formatter.test.ts`:

```typescript
describe("formatObservationIndexRow — cross-project attribution", () => {
  const makeObs = (project: string): Observation => ({
    id: 42,
    sdkSessionId: "sess-1",
    project,
    type: "bugfix",
    title: "Fix auth timeout",
    subtitle: null,
    narrative: null,
    facts: [],
    concepts: [],
    filesRead: [],
    filesModified: [],
    promptNumber: 1,
    discoveryTokens: 5000,
    createdAt: new Date().toISOString(),
    createdAtEpoch: Date.now(),
  });

  it("adds [from: project] label for cross-project observations", () => {
    const row = formatObservationIndexRow(makeObs("other-project"), "my-project");
    expect(row).toContain("[from: other-project]");
  });

  it("does not add label for same-project observations", () => {
    const row = formatObservationIndexRow(makeObs("my-project"), "my-project");
    expect(row).not.toContain("[from:");
  });

  it("does not add label when no currentProject provided", () => {
    const row = formatObservationIndexRow(makeObs("any-project"));
    expect(row).not.toContain("[from:");
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test tests/unit/context-formatter.test.ts`
Expected: FAIL — `formatObservationIndexRow` doesn't accept a second parameter

**Step 3: Implementation already done in Task 7**

The `formatObservationIndexRow` was updated in Task 7 to accept `currentProject`. Verify the implementation is in place.

**Step 4: Run tests to verify they pass**

Run: `bun test tests/unit/context-formatter.test.ts`
Expected: All tests PASS

**Step 5: Run full test suite**

Run: `bun test`
Expected: All tests PASS

**Step 6: Commit**

```bash
git add src/utils/context-formatter.ts tests/unit/context-formatter.test.ts
git commit -m "feat: cross-project attribution labels in context index"
```

---

### Task 11: Integration Verification

**Files:**
- All modified files

**Step 1: Run full test suite**

Run: `bun test`
Expected: All tests PASS (256+ original + new tests)

**Step 2: Build the project**

Run: `bun run build`
Expected: Build succeeds with no errors

**Step 3: Verify no TypeScript errors**

Run: `bunx tsc --noEmit`
Expected: No type errors

**Step 4: Commit any remaining fixes**

```bash
git add -A
git commit -m "chore: integration verification — all tests pass"
```

---

### Task Dependency Graph

```
Task 1 (relevance module) ──────────────────────────┐
Task 2 (tool filtering) ─────────────── independent  │
Task 3 (summary hook fix) ──────────── independent  │
Task 4 (git project ID) ───────────── independent   │
Task 5 (migration v5) ──────┐                       │
Task 6 (cross-project DB) ──┤── depends on 5        │
Task 7 (context handler) ───┤── depends on 1, 6     │
Task 8 (deduplication) ─────┤── depends on 6        │
Task 9 (batching) ──────────┘── independent          │
Task 10 (attribution) ──────────── depends on 7      │
Task 11 (integration) ──────────── depends on all   ─┘
```

**Parallelizable groups:**
- **Group 1** (independent): Tasks 1, 2, 3, 4 can all be done in parallel
- **Group 2** (depends on Group 1): Tasks 5, 9
- **Group 3** (depends on Group 2): Tasks 6, 7, 8, 10
- **Group 4**: Task 11 (integration verification)
