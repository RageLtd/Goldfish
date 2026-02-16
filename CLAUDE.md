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

- **Worker** (`src/worker/`): Background HTTP server (Bun, port 3456). `service.ts` routes requests to `handlers.ts`. `message-router.ts` holds a sequential FIFO queue for processing. Messages are dispatched to `local-agent.ts`.

- **Local Agent** (`src/worker/local-agent.ts`): Processes observations and summaries through llama.cpp CLI binaries via `ModelManager`. Sends structured prompts (`src/models/prompts.ts`), receives tool calls in XML format, parsed by `src/models/tool-call-parser.ts` into domain types.

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
| `CLAUDE_MEM_LOG_LEVEL` | `INFO` | Logging verbosity |
| `CLAUDE_MEM_CONTEXT_OBSERVATIONS` | `50` | Max observations in context |
| `CLAUDE_MEM_RECENCY_HALFLIFE_DAYS` | `2` | Recency decay half-life |
| `CLAUDE_MEM_CROSS_PROJECT` | `true` | Enable cross-project retrieval |
| `CLAUDE_MEM_SKIP_TOOLS` | `TodoRead,TodoWrite,LS` | Tools filtered from pipeline |
| `CLAUDE_MEM_BATCH_WINDOW_MS` | `3000` | Observation batching window |
| `CLAUDE_MEM_LLAMA_GENERATION_MODEL` | `~/.claude-mem/models/Qwen3-0.6B-Q8_0.gguf` | Path to GGUF generative model |
| `CLAUDE_MEM_LLAMA_EMBEDDING_MODEL` | `~/.claude-mem/models/all-MiniLM-L6-v2-Q8_0.gguf` | Path to GGUF embedding model |
| `CLAUDE_MEM_LLAMA_CLI_PATH` | `~/.claude-mem/bin` | Directory containing llama.cpp binaries |
| `CLAUDE_MEM_MODEL_DIR` | `~/.claude-mem/models` | Model cache directory |

## Installation & Runtime Dependencies

The `ensure-binary.sh` SessionStart hook downloads all runtime dependencies on first use:

1. **claude-mem binary** → `$PLUGIN_ROOT/bin/claude-mem` (from GitHub Releases)
2. **llama.cpp binaries** → `~/.claude-mem/bin/` (from GitHub Releases, built in CI)
3. **GGUF models** → `~/.claude-mem/models/` (from HuggingFace, ~685MB total)

Version checking uses GitHub release tags (phases 1-2) and HuggingFace ETags (phase 3) to avoid re-downloading on subsequent runs.

### File Layout

```
~/.claude-mem/
├── bin/                          # llama.cpp binaries + shared libs
│   ├── llama-completion
│   ├── llama-embedding
│   └── libllama.* / libggml*.*   # shared libraries
├── models/
│   ├── all-MiniLM-L6-v2-Q8_0.gguf   # 46MB embedding model
│   └── Qwen3-0.6B-Q8_0.gguf         # 639MB generation model
├── memory.db
└── .version                      # installed release tag
```

### Supported Platforms

- **darwin-arm64** (macOS Apple Silicon)
- **linux-x64** (Linux x86_64)

## Versioning

Automated via conventional commits: `feat!:` (major), `feat:` (minor), `fix:` (patch), `docs:`/`chore:` (no release).
