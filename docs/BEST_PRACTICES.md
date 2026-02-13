# Best Practices

Learnings and recommendations discovered during development.

## Bun SQLite

- Always use WAL mode and `synchronous=NORMAL` for concurrent read/write access
- Use FTS5 (not FTS4) — better ranking with `rank` column, more efficient
- Pass `db: Database` as first parameter to all database functions (pure function pattern)
- Prepared statements via `.query()` are cached by Bun — prefer over `.run()` for repeated queries

## Claude Agent SDK

- XML block extraction is the most reliable output format from SDK agent responses
- Use defensive parsing — SDK responses may be truncated or malformed
- The SDK subprocess inherits environment variables, so `ANTHROPIC_API_KEY` must be set in the worker process

## Hooks

- Hooks must never crash or block Claude Code — always return valid output regardless of errors
- Fire-and-forget HTTP pattern: hooks POST to worker and don't wait for processing to complete
- Keep hook startup time minimal — lazy-load modules, avoid expensive imports at top level

## Testing

- Use `bun:test` with `describe`/`it`/`expect` — no external test framework needed
- In-memory SQLite (`:memory:`) for database tests — fast, isolated, no cleanup
- Create fresh database + migrations in `beforeEach` for test isolation
