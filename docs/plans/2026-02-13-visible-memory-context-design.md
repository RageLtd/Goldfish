# Visible Memory Context Display

**Date:** 2026-02-13
**Status:** Approved

## Problem

When claude-mem loads memories at session start or via the mem-search skill, the user sees only a terse one-line message like:

```
SessionStart:startup says: [claude-mem] Loaded context from previous sessions
```

There is no visibility into what memories were actually loaded. The full index goes into `additionalContext` (a system-reminder block), but the user has no summary to understand what's there without expanding.

## Solution

Use both hook output channels strategically:

- **`systemMessage`**: Rich, source-aware summary with observation counts by type
- **`additionalContext`**: Full index table (already works, no change needed)
- **SKILL.md**: Display rule for skill-based searches to show summary first

## Design

### 1. Worker API Change — `/context` endpoint

Add `typeCounts` to the response:

```json
{
  "context": "# project recent context\n...",
  "observationCount": 10,
  "summaryCount": 3,
  "format": "index",
  "typeCounts": {
    "decision": 3,
    "feature": 5,
    "bugfix": 1,
    "discovery": 1
  }
}
```

Computed from observations already fetched — no new DB queries.

### 2. Hook — Source-Aware systemMessage

The `SessionStartInput.source` field (`startup | resume | clear | compact`) is used to prefix the message appropriately:

| Source | Message |
|--------|---------|
| `startup` | `[claude-mem] 12 memories loaded (3 decisions, 5 features, 2 bugfixes, 2 discoveries)` |
| `clear` | `[claude-mem] Fresh session — 12 memories loaded (3 decisions, 5 features, 2 bugfixes, 2 discoveries)` |
| `resume` | `[claude-mem] Resumed — 12 memories loaded (3 decisions, 5 features, 2 bugfixes, 2 discoveries)` |
| `compact` | `[claude-mem] Compacted — 12 memories loaded (3 decisions, 5 features, 2 bugfixes, 2 discoveries)` |
| No observations | `[claude-mem] No previous context for this project` |

Rules:
- Only non-zero types are listed in the parenthetical
- Use plain text labels (no emoji) for type names
- If session summaries exist, append: `+ 3 session summaries`

### 3. Hook — processContextHook Changes

In `src/hooks/logic.ts`:

1. Accept `typeCounts` from the worker response (add to the type assertion)
2. Accept `source` from `SessionStartInput` (already available on `input`)
3. Build the systemMessage using a helper that:
   - Filters typeCounts to non-zero entries
   - Formats them as `"3 decisions, 5 features, ..."`
   - Prepends source-appropriate prefix
4. `additionalContext` remains unchanged (full index table)

### 4. Skill — SKILL.md Display Rule

Add to `plugin/skills/mem-search/SKILL.md`:

> **Display Rule:** When presenting search results to the user, always start with a one-line summary of what was found (e.g., "Found 8 observations: 3 decisions, 2 features, 2 discoveries, 1 bugfix") before presenting the index table or details.

### 5. Files Changed

| File | Change |
|------|--------|
| Worker route for `/context` | Add `typeCounts` to response |
| `src/hooks/logic.ts` | Build richer `systemMessage` from `typeCounts` and `source` |
| `plugin/skills/mem-search/SKILL.md` | Add display rule for summary-first output |

### 6. End-to-End Flow

1. Session starts -> hook calls worker `/context`
2. Worker returns context + `typeCounts` + counts
3. Hook reads `input.source` and `typeCounts`, builds descriptive `systemMessage`
4. Claude Code renders the visible "says:" line with the summary
5. Full index is available in the expandable system-reminder block
6. Skill searches show a summary line before presenting results
