# Smarter Memory Retrieval - Design Document

**Date:** 2026-02-12
**Status:** Approved
**Scope:** Full pipeline improvement - noise reduction + intelligent retrieval + cross-project context

## Problem Statement

claude-mem's current memory retrieval has three core weaknesses:

1. **Too much noise**: Every tool execution reaches the SDK agent, including trivial operations. This wastes tokens and dilutes memory quality.
2. **Flat retrieval**: Context injection returns the N most recent observations sorted by time. No relevance scoring, no semantic matching.
3. **Project isolation**: Observations from other projects are invisible, even when highly relevant (e.g., fixing the same bug in a different project).

## Design

### Phase 1: Noise Reduction

#### 1a. Tool Filtering in save-hook

**File:** `src/hooks/logic.ts`

Add a configurable skip list at the hook layer so trivial tools never reach the worker:

```typescript
const DEFAULT_SKIP_TOOLS = ["TodoRead", "TodoWrite", "LS"];
```

Configurable via `CLAUDE_MEM_SKIP_TOOLS` environment variable (comma-separated).

Also skip observations where `toolInput` + `toolResponse` combined text is < 50 characters (empty/trivial results).

#### 1b. Observation Batching in SessionManager

**File:** `src/worker/session-manager.ts`

Buffer observations for a short window (3 seconds). When the buffer flushes, consecutive tool executions of the same type get merged into a single batch before being sent to the SDK agent.

The `queueObservation` method checks if the pending queue's last item is the same tool type and within the batch window. If so, merge the tool inputs/responses rather than creating separate entries.

This reduces SDK calls by ~40% for typical exploration patterns (sequential file reads, glob searches).

#### 1c. Smarter Project Identification

**File:** `src/utils/validation.ts`

Replace the naive `basename(cwd)` approach:

1. Try `git rev-parse --show-toplevel` (cached per-cwd per process lifetime)
2. Extract the repo name from the git root path
3. Fall back to basename if not in a git repo
4. Handle worktrees correctly (use main repo name, not worktree directory name)

### Phase 2: Smarter Retrieval

#### 2a. Fix Summary Hook

**Files:** `src/hooks/logic.ts`, `src/hooks/summary-hook.ts`

The Stop hook receives `transcript_path`, `last_assistant_message`, and `last_user_message` in its stdin input. Extract these and forward them to the `/summary` endpoint instead of empty strings. This gives the SDK agent actual context to generate meaningful summaries.

#### 2b. Relevance-Scored Context Injection with Cross-Project Support

**Files:** `src/worker/handlers.ts`, `src/utils/relevance.ts` (new), `src/db/index.ts`

Replace flat `getRecentObservations` with unified relevance scoring across all projects.

##### Scoring Formula

```
score = recencyScore(epoch, halfLifeDays)     // 0-1.0
      + typeScore(type)                        // 0.3-0.8
      + similarityScore(observation, query)    // 0-1.5 (highest weight)
      + fileOverlapScore(observation, cwd)     // 0-1.0
      + currentProjectBonus                    // 0.1
```

##### Factor Details

| Factor | Range | Description |
|--------|-------|-------------|
| Recency | 0-1.0 | Exponential decay: `exp(-0.693 * ageDays / halfLifeDays)`. Half-life configurable via `CLAUDE_MEM_RECENCY_HALFLIFE_DAYS` (default: 2) |
| Type importance | 0.3-0.8 | decision=0.8, bugfix=0.7, discovery=0.6, feature=0.5, refactor=0.4, change=0.3 |
| Semantic similarity | 0-1.5 | FTS5 rank (normalized) + concept tag overlap. Heaviest factor. |
| File overlap | 0-1.0 | Proportion of observation files that exist under current cwd |
| Same project | 0.1 | Minimal additive tiebreaker for current project |

##### Cross-Project Behavior

- **No hard caps**: All projects compete in the same scoring pool
- **No penalties**: Cross-project observations are not penalized, just lack the 0.1 same-project bonus
- **Attribution**: Cross-project observations are labeled `[from: other-project]` in formatted output
- **Key scenario**: A bugfix in Project A that matches keywords from the current prompt in Project B scores high because semantic similarity (1.5 max) dominates

##### Retrieval Strategy

1. Query FTS5 with extracted keywords from cwd file paths (at SessionStart, no prompt available yet)
2. Get candidate observations (limit * 3 to allow for re-ranking)
3. Score each candidate with the formula above
4. Sort by score descending, take top N
5. Format with project attribution for cross-project items

##### SessionStart vs On-Demand

- **SessionStart**: Uses cwd-based signals only (no user prompt yet)
- **mem-search skill**: Can use the user's actual prompt for better semantic matching
- Future: re-score after UserPromptSubmit hook fires (out of scope for now)

#### 2c. Observation Deduplication

**File:** `src/worker/sdk-agent.ts`

Before storing a new observation, check for near-duplicates:

1. Query FTS5 with the new observation's title
2. Filter candidates to same project, created within the last hour
3. Compare title similarity (simple Jaccard on word tokens)
4. Skip storing if similarity > 80%

This prevents the same insight from being stored multiple times during iterative work.

### Database Changes

**File:** `src/db/migrations.ts`

New migration (version 5):

```sql
-- Index for concept-based filtering
CREATE INDEX IF NOT EXISTS idx_observations_concepts ON observations(concepts);

-- Composite index for cross-project queries
CREATE INDEX IF NOT EXISTS idx_observations_project_epoch
  ON observations(project, created_at_epoch DESC);
```

No schema changes needed - existing columns support all new queries.

### New File: `src/utils/relevance.ts`

Pure functions for scoring:

- `calculateRecencyScore(epoch, halfLifeDays)` - exponential decay
- `calculateTypeScore(type)` - lookup table
- `calculateSimilarityScore(fts5Rank, conceptOverlap)` - normalized combination
- `calculateFileOverlapScore(obsFiles, cwdFiles)` - set intersection ratio
- `scoreObservation(observation, context)` - combines all factors
- All weights configurable through a `ScoringConfig` type with defaults

### Configuration

New environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `CLAUDE_MEM_SKIP_TOOLS` | `TodoRead,TodoWrite,LS` | Comma-separated tools to skip in save-hook |
| `CLAUDE_MEM_RECENCY_HALFLIFE_DAYS` | `2` | Recency decay half-life in days |
| `CLAUDE_MEM_BATCH_WINDOW_MS` | `3000` | Observation batching window in ms |
| `CLAUDE_MEM_CROSS_PROJECT` | `true` | Enable cross-project context |

### Files Changed Summary

| File | Change Type | Description |
|------|-------------|-------------|
| `src/hooks/logic.ts` | Modify | Add SKIP_TOOLS, fix summary message extraction |
| `src/hooks/summary-hook.ts` | Modify | Pass StopInput fields properly |
| `src/worker/session-manager.ts` | Modify | Observation batching with merge window |
| `src/worker/handlers.ts` | Modify | Relevance scoring + cross-project context |
| `src/worker/sdk-agent.ts` | Modify | Deduplication check before store |
| `src/utils/validation.ts` | Modify | Git-repo-root project identification |
| `src/utils/relevance.ts` | **New** | Scoring functions with configurable weights |
| `src/db/index.ts` | Modify | New query functions for cross-project search |
| `src/db/migrations.ts` | Modify | Add new indexes (migration v5) |
| `src/utils/context-formatter.ts` | Modify | Cross-project attribution in index format |
| `src/types/hooks.ts` | Modify | Update StopInput type if needed |

### Out of Scope

- ChromaDB vector search wiring (separate effort, needs external dependency)
- Mid-session context refresh (needs new hook type)
- Prompt-based re-scoring after UserPromptSubmit (future enhancement)

### Testing Strategy

Each new function gets unit tests:
- Scoring functions: test each factor independently, test combined scoring
- Tool filtering: test skip list, size threshold
- Observation batching: test merge window, different tool types
- Deduplication: test similarity threshold, time window
- Cross-project queries: test scoring across projects, attribution formatting
- Git project detection: test repos, worktrees, non-git dirs
