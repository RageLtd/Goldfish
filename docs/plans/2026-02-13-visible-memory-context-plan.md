# Visible Memory Context Display — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make loaded memories visible to the user as a summary line (systemMessage) with full index in the expandable system-reminder block.

**Architecture:** Add `typeCounts` to the worker `/context` response, then use it in the hook to build a source-aware systemMessage. Update SKILL.md with a display rule for skill-based searches.

**Tech Stack:** TypeScript, Bun test runner, SQLite (existing)

**Design doc:** `docs/plans/2026-02-13-visible-memory-context-design.md`

---

### Task 1: Add `typeCounts` to worker `/context` response

**Files:**
- Modify: `src/worker/handlers.ts:454-518` (handleGetContext function)
- Test: `tests/unit/worker-handlers.test.ts`

**Step 1: Write the failing test**

Add to `tests/unit/worker-handlers.test.ts` inside the `describe("handleGetContext")` block:

```typescript
it("returns typeCounts in the response", async () => {
	// Setup: create session and store observations with different types
	const sessionId = createSession(db, {
		claudeSessionId: "claude-types",
		project: "test-project",
		userPrompt: "Test",
	});

	// Store observations with different types
	storeObservation(db, {
		sdkSessionId: sessionId,
		project: "test-project",
		type: "decision",
		title: "Choose REST over GraphQL",
		subtitle: null,
		narrative: null,
		facts: [],
		concepts: [],
		filesRead: [],
		filesModified: [],
		promptNumber: 1,
		discoveryTokens: 100,
	});
	storeObservation(db, {
		sdkSessionId: sessionId,
		project: "test-project",
		type: "feature",
		title: "Add login page",
		subtitle: null,
		narrative: null,
		facts: [],
		concepts: [],
		filesRead: [],
		filesModified: [],
		promptNumber: 2,
		discoveryTokens: 200,
	});
	storeObservation(db, {
		sdkSessionId: sessionId,
		project: "test-project",
		type: "feature",
		title: "Add signup page",
		subtitle: null,
		narrative: null,
		facts: [],
		concepts: [],
		filesRead: [],
		filesModified: [],
		promptNumber: 3,
		discoveryTokens: 150,
	});

	const result = await handleGetContext(deps, {
		project: "test-project",
		limit: 10,
	});

	expect(result.status).toBe(200);
	expect(result.body.typeCounts).toBeDefined();
	expect(result.body.typeCounts.decision).toBe(1);
	expect(result.body.typeCounts.feature).toBe(2);
});

it("returns empty typeCounts when no observations", async () => {
	const result = await handleGetContext(deps, {
		project: "empty-project",
		limit: 10,
	});

	expect(result.status).toBe(200);
	// When no observations, typeCounts should be empty or all zeros
	expect(result.body.typeCounts).toBeDefined();
});
```

Note: Check what `storeObservation` is called in the test file — look at existing test helpers and imports at the top of `tests/unit/worker-handlers.test.ts`. Use the same pattern. The field names above are from `src/types/domain.ts:ParsedObservation`.

**Step 2: Run test to verify it fails**

Run: `bun test tests/unit/worker-handlers.test.ts --filter "typeCounts"`
Expected: FAIL — `typeCounts` is not in the response body

**Step 3: Write minimal implementation**

In `src/worker/handlers.ts`, modify `handleGetContext` (lines 454-518).

After line 488 (after observations are filtered), add type count computation:

```typescript
// Compute type counts from observations
const typeCounts: Record<string, number> = {};
for (const obs of observations) {
	typeCounts[obs.type] = (typeCounts[obs.type] ?? 0) + 1;
}
```

Then add `typeCounts` to both response bodies:

In the empty case (line 494-500), add `typeCounts: {}` to the body.

In the normal case (line 509-517), add `typeCounts` to the body:

```typescript
return {
	status: 200,
	body: {
		context,
		observationCount: observations.length,
		summaryCount: summaries.length,
		format,
		typeCounts,
	},
};
```

**Step 4: Run test to verify it passes**

Run: `bun test tests/unit/worker-handlers.test.ts --filter "typeCounts"`
Expected: PASS

**Step 5: Run full handler test suite**

Run: `bun test tests/unit/worker-handlers.test.ts`
Expected: All existing tests still pass

**Step 6: Commit**

```bash
git add src/worker/handlers.ts tests/unit/worker-handlers.test.ts
git commit -m "feat: add typeCounts to /context response"
```

---

### Task 2: Add `formatSystemMessage` helper to hook logic

**Files:**
- Modify: `src/hooks/logic.ts`
- Test: `tests/unit/hook-logic.test.ts`

**Step 1: Write the failing tests**

Add to `tests/unit/hook-logic.test.ts`. First, import the new helper at the top alongside the existing imports:

```typescript
import {
	type HookDeps,
	processCleanupHook,
	processContextHook,
	processNewHook,
	processSaveHook,
	processSummaryHook,
	formatSystemMessage,
} from "../../src/hooks/logic";
```

Then add a new describe block:

```typescript
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
			"[claude-mem] Fresh session — 5 memories loaded (3 features, 2 bugfixes)",
		);
	});

	it("formats resume source with prefix", () => {
		const result = formatSystemMessage("resume", 5, 0, {
			feature: 5,
		});
		expect(result).toBe(
			"[claude-mem] Resumed — 5 memories loaded (5 features)",
		);
	});

	it("formats compact source with prefix", () => {
		const result = formatSystemMessage("compact", 3, 1, {
			decision: 3,
		});
		expect(result).toBe(
			"[claude-mem] Compacted — 3 memories loaded (3 decisions) + 1 session summary",
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
		const result = formatSystemMessage("startup", 3, 1, { feature: 3 });
		expect(result).toBe(
			"[claude-mem] 3 memories loaded (3 features) + 1 session summary",
		);
	});

	it("defaults to startup when source is undefined", () => {
		const result = formatSystemMessage(undefined, 5, 0, { feature: 5 });
		expect(result).toBe("[claude-mem] 5 memories loaded (5 features)");
	});
});
```

**Step 2: Run test to verify it fails**

Run: `bun test tests/unit/hook-logic.test.ts --filter "formatSystemMessage"`
Expected: FAIL — function not exported

**Step 3: Write minimal implementation**

Add to `src/hooks/logic.ts`, before the `processContextHook` function:

```typescript
/**
 * Builds a source-aware system message summarizing loaded context.
 * Used by the context hook to tell the user what memories were loaded.
 */
export const formatSystemMessage = (
	source: string | undefined,
	observationCount: number,
	summaryCount: number,
	typeCounts: Record<string, number>,
): string => {
	const hasObservations = observationCount > 0;
	const hasSummaries = summaryCount > 0;

	if (!hasObservations && !hasSummaries) {
		return "[claude-mem] No previous context for this project";
	}

	// Build type breakdown (only non-zero types)
	const typeBreakdown = Object.entries(typeCounts)
		.filter(([, count]) => count > 0)
		.map(([type, count]) => `${count} ${type}${count !== 1 ? "s" : ""}`)
		.join(", ");

	// Build summary suffix
	const summarySuffix = hasSummaries
		? ` + ${summaryCount} session ${summaryCount === 1 ? "summary" : "summaries"}`
		: "";

	// Handle case with only summaries
	if (!hasObservations) {
		return `[claude-mem] ${summaryCount} session ${summaryCount === 1 ? "summary" : "summaries"} loaded`;
	}

	// Build memories part
	const memoriesPart = typeBreakdown
		? `${observationCount} memories loaded (${typeBreakdown})`
		: `${observationCount} memories loaded`;

	// Source prefix
	const prefix = (() => {
		switch (source) {
			case "clear":
				return "[claude-mem] Fresh session — ";
			case "resume":
				return "[claude-mem] Resumed — ";
			case "compact":
				return "[claude-mem] Compacted — ";
			default:
				return "[claude-mem] ";
		}
	})();

	return `${prefix}${memoriesPart}${summarySuffix}`;
};
```

**Step 4: Run test to verify it passes**

Run: `bun test tests/unit/hook-logic.test.ts --filter "formatSystemMessage"`
Expected: PASS

**Step 5: Commit**

```bash
git add src/hooks/logic.ts tests/unit/hook-logic.test.ts
git commit -m "feat: add formatSystemMessage helper for source-aware context summary"
```

---

### Task 3: Wire `formatSystemMessage` into `processContextHook`

**Files:**
- Modify: `src/hooks/logic.ts:97-135` (processContextHook)
- Test: `tests/unit/hook-logic.test.ts`

**Step 1: Write the failing tests**

Update existing tests and add new ones in the `describe("processContextHook")` block in `tests/unit/hook-logic.test.ts`:

```typescript
it("includes type counts in system message", async () => {
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
					context: "## Previous work\n- Did stuff",
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
```

**Step 2: Run test to verify it fails**

Run: `bun test tests/unit/hook-logic.test.ts --filter "processContextHook"`
Expected: FAIL — systemMessage still uses old format

**Step 3: Update processContextHook**

In `src/hooks/logic.ts`, update the `processContextHook` function to:

1. Add `typeCounts` to the type assertion (alongside `observationCount`, `summaryCount`, etc.)
2. Replace the `hasContext`/`systemMessage` logic with a call to `formatSystemMessage`

```typescript
export const processContextHook = async (
	deps: HookDeps,
	input: SessionStartInput,
): Promise<HookOutput> => {
	const project = extractProject(input.cwd);

	if (!project) {
		return createSuccessOutput();
	}

	try {
		const result = (await getFromWorker(deps, "/context", {
			project,
			limit: "50",
			format: "index",
		})) as {
			context?: string;
			observationCount?: number;
			summaryCount?: number;
			format?: string;
			typeCounts?: Record<string, number>;
		};

		if (result.context?.trim()) {
			const systemMessage = formatSystemMessage(
				input.source,
				result.observationCount ?? 0,
				result.summaryCount ?? 0,
				result.typeCounts ?? {},
			);

			return createContextOutput(result.context, systemMessage);
		}

		return createSuccessOutput();
	} catch {
		return createSuccessOutput();
	}
};
```

**Step 4: Run test to verify it passes**

Run: `bun test tests/unit/hook-logic.test.ts --filter "processContextHook"`
Expected: PASS

**Step 5: Run full hook logic test suite**

Run: `bun test tests/unit/hook-logic.test.ts`
Expected: All tests pass (existing tests may need the mock response updated to include `typeCounts`)

**Step 6: Commit**

```bash
git add src/hooks/logic.ts tests/unit/hook-logic.test.ts
git commit -m "feat: wire formatSystemMessage into processContextHook"
```

---

### Task 4: Update SKILL.md with display rule

**Files:**
- Modify: `plugin/skills/mem-search/SKILL.md`

**Step 1: Add display rule**

Add a new section after the `## When to Use` section in `plugin/skills/mem-search/SKILL.md`:

```markdown
## Display Rule

When presenting search results to the user, **always start with a one-line summary** of what was found before showing details. This gives the user immediate visibility into what context is available.

**Format:** "Found N observations: X decisions, Y features, Z bugfixes, ..."

Examples:
- "Found 8 observations: 3 decisions, 2 features, 2 discoveries, 1 bugfix"
- "Found 3 observations matching 'authentication': 2 features, 1 decision"
- "No observations found matching 'payment gateway'"

Only list non-zero types. Always show the summary before presenting the index table or details.
```

**Step 2: Verify skill file is valid**

Read the modified file to confirm the markdown is well-formed and the new section fits naturally in the document flow.

**Step 3: Commit**

```bash
git add plugin/skills/mem-search/SKILL.md
git commit -m "docs: add display rule to mem-search skill for summary-first output"
```

---

### Task 5: Run full test suite and verify

**Files:**
- None (validation only)

**Step 1: Run all unit tests**

Run: `bun test tests/unit/`
Expected: All tests pass

**Step 2: Build the binary**

Run: Check `package.json` for the build command and run it.
Expected: Build succeeds with no errors

**Step 3: Commit any remaining changes**

If any test adjustments were needed, commit them:

```bash
git add -A
git commit -m "test: fix tests for visible memory context display"
```
