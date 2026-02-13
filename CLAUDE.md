# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
bun install              # Install dependencies
bun test                 # Run all tests
bun test tests/unit/     # Run unit tests only
bun test tests/unit/database.test.ts               # Run a single test file
bun test tests/unit/database.test.ts -t "stores"   # Run tests matching pattern
bun run build            # Compile standalone binary (output: plugin/bin/claude-mem)
bun run worker:start     # Start worker service locally
bunx biome check --write .  # Format + lint (run before committing)
```

## Architecture

claude-mem is a persistent memory system for Claude Code. It captures tool executions via lifecycle hooks, processes them through Claude SDK to extract semantic meaning, stores in SQLite with FTS5, and injects relevant context into new sessions.

### Data Flow

```
Claude Code hooks → HTTP POST → Worker Service → SessionManager queue
                                                        ↓
                                           BackgroundProcessor polls
                                                        ↓
                                              SDKAgent (Claude AI)
                                                        ↓
                                          SQLite + FTS5 (persist)
                                                        ↓
                                    Context hook reads back → Claude Code
```

### Key Layers

- **Hooks** (`src/hooks/`): Fire-and-forget HTTP clients running in Claude Code's process. Each hook maps to a lifecycle event (SessionStart, UserPromptSubmit, PostToolUse, Stop, SessionEnd). They must be fast — the worker does the heavy lifting.

- **Worker** (`src/worker/`): Background HTTP server (Bun, port 3456). `service.ts` routes requests to `handlers.ts`. `session-manager.ts` holds in-memory state with async message queues and TTL-based eviction. `background-processor.ts` polls queues and dispatches to `sdk-agent.ts`.

- **SDK Agent** (`src/worker/sdk-agent.ts`): Spawns Claude subprocess via `@anthropic-ai/claude-agent-sdk`. Sends structured prompts (`src/sdk/prompts.ts`), receives XML blocks, parsed by `src/sdk/parser.ts` into domain types.

- **Database** (`src/db/`): Pure functions taking `db: Database` as first arg. `migrations.ts` handles versioned schema. Tables: `sdk_sessions`, `observations` (with FTS5), `session_summaries` (with FTS5), `user_prompts` (with FTS5). WAL mode enabled.

- **Context Retrieval** (`src/worker/handlers.ts:handleGetContext`): Cross-project relevance scoring. Fetches candidates from all projects, scores with recency decay + type importance + FTS similarity + file overlap + same-project bonus, returns top-N.

### Entry Point

`src/cli.ts` — unified binary with subcommands (`hook:context`, `hook:new`, `hook:save`, `hook:summary`, `hook:cleanup`, `worker`, `version`). Hook modules are lazy-loaded to minimize startup time.

## Code Conventions

### Result Pattern (not try/catch)

All database and fallible operations return `Result<T, E>` from `src/types/result.ts`:

```typescript
const result = storeObservation(db, input);
if (!result.ok) {
    return { status: 500, body: { error: result.error.message } };
}
// result.value is typed T
```

Helpers: `ok()`, `err()`, `isOk()`, `isErr()`, `map()`, `flatMap()`, `fromPromise()`.

### Functional Style

No classes or OOP. Pure functions, immutable data (`readonly` on all interface fields and arrays), composition over inheritance. The one exception is `SessionManager` which uses a factory function returning a plain object with methods.

### Formatting

- **2 spaces** for indentation (biome.json)
- **Double quotes** for strings
- Run `bunx biome check --write .` before committing

### Domain Types

All in `src/types/domain.ts`. Observation types: `decision | bugfix | feature | refactor | discovery | change`. All fields `readonly`, arrays `readonly string[]`.

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `CLAUDE_MEM_PORT` | `3456` | Worker HTTP port |
| `CLAUDE_MEM_DB` | `~/.claude-mem/memory.db` | SQLite path |
| `CLAUDE_MEM_MODEL` | `claude-haiku-4-5` | SDK agent model |
| `CLAUDE_MEM_LOG_LEVEL` | `INFO` | Logging verbosity |
| `CLAUDE_MEM_CONTEXT_OBSERVATIONS` | `50` | Max observations in context |
| `CLAUDE_MEM_RECENCY_HALFLIFE_DAYS` | `2` | Recency decay half-life |
| `CLAUDE_MEM_CROSS_PROJECT` | `true` | Enable cross-project retrieval |
| `CLAUDE_MEM_SKIP_TOOLS` | `TodoRead,TodoWrite,LS` | Tools filtered from pipeline |
| `CLAUDE_MEM_BATCH_WINDOW_MS` | `3000` | Observation batching window |

## Versioning

Automated via conventional commits: `feat!:` (major), `feat:` (minor), `fix:` (patch), `docs:`/`chore:` (no release).
