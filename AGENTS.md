# Goldfish

Claude Code plugin for persistent agent memory — because your AI shouldn't have the memory of a goldfish. Captures tool executions via lifecycle hooks, extracts semantic meaning through local LLMs (llama.cpp), stores in SQLite with FTS5, and injects relevant context into new sessions.

## Commands

```bash
bun install              # Install dependencies
bun test                 # Run all tests
bun test tests/unit/     # Run unit tests only
bun run build            # Compile standalone binary (output: bin/goldfish)
bun run worker:start     # Start worker service locally
bunx biome check --write .  # Format + lint
```

## Architecture

```
Hooks (src/hooks/) → HTTP POST → Worker (src/worker/service.ts)
                                        → message-router.ts (FIFO queue)
                                        → local-agent.ts (llama.cpp inference)
                                        → SQLite + FTS5 (src/db/)
                                        → context retrieval → Claude Code
```

**Entry point:** `src/cli.ts` — subcommands: `hook:context`, `hook:new`, `hook:save`, `hook:summary`, `hook:cleanup`, `worker`, `version`. Hooks are lazy-loaded for fast startup.

**Hooks** are fire-and-forget HTTP clients — they must be fast. The worker does all heavy processing.

**Context retrieval** (`src/worker/handlers.ts:handleGetContext`) scores candidates across all projects using recency decay + type importance + FTS similarity + file overlap + same-project bonus.

## Key Patterns

**Result pattern** — all fallible operations return `Result<T, E>` from `src/types/result.ts`. No try/catch.
```typescript
const result = storeObservation(db, input);
if (!result.ok) return { status: 500, body: { error: result.error.message } };
// result.value is typed T
```
Helpers: `ok()`, `err()`, `isOk()`, `isErr()`, `map()`, `flatMap()`, `fromPromise()`.

**Functional style** — pure functions, `readonly` on all interface fields and arrays, composition over inheritance. No classes. `SessionManager` uses a factory function returning a plain object.

**Domain types** — `src/types/domain.ts`. Observation types: `decision | bugfix | feature | refactor | discovery | change`.

**Database** — pure functions taking `db: Database` as first arg. Tables: `sdk_sessions`, `observations` (FTS5), `session_summaries` (FTS5), `user_prompts` (FTS5). WAL mode. Versioned migrations in `src/db/migrations.ts`.

## Testing

- Runtime: `bun:test` with in-memory SQLite (`:memory:`)
- Location: `tests/unit/`
- Pattern: one test file per module, named `<module>.test.ts`

## Versioning

Automated via conventional commits: `feat!:` (major), `feat:` (minor), `fix:` (patch), `docs:`/`chore:` (no release).
