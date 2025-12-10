# claude-mem-bun

Persistent memory system for Claude Code - context compression and recall across sessions.

## Overview

Claude-mem captures tool executions via Claude Code lifecycle hooks, processes them through Claude AI to extract semantic meaning, and stores structured observations in SQLite with full-text search. Relevant context is automatically injected back into new sessions.

```
Claude Code ──► Hooks ──► Worker Service ──► SDK Agent ──► Database
                              │                              │
                              └──────────────────────────────┘
                                    Context Injection
```

## Installation

```bash
bun install
```

## Building

Build the unified CLI binary:

```bash
bun run build
```

This creates a single executable at `plugin/bin/claude-mem` (~58MB) with all functionality.

## Usage

### CLI Commands

```bash
./plugin/bin/claude-mem hook:context   # SessionStart hook - inject past context
./plugin/bin/claude-mem hook:new       # UserPromptSubmit hook - create/update session
./plugin/bin/claude-mem hook:save      # PostToolUse hook - capture observations
./plugin/bin/claude-mem hook:summary   # Stop hook - generate session summary
./plugin/bin/claude-mem hook:cleanup   # SessionEnd hook - mark session complete
./plugin/bin/claude-mem worker         # Start HTTP worker service
./plugin/bin/claude-mem mcp            # Start MCP server (stdio)
./plugin/bin/claude-mem version        # Show version
```

### Worker Service

The worker service starts automatically when hooks are invoked. To run it manually:

```bash
./plugin/bin/claude-mem worker
```

## Claude Code Plugin

This project is designed as a Claude Code plugin. The plugin structure is in `plugin/`:

- `plugin/.claude-plugin/plugin.json` - Plugin manifest with MCP server config
- `plugin/hooks/hooks.json` - Hook configurations for lifecycle events

### Hook Lifecycle

1. **SessionStart** - Injects relevant past observations as context
2. **UserPromptSubmit** - Creates/updates session, saves user prompt
3. **PostToolUse** - Captures tool executions as observations
4. **Stop** - Generates end-of-session summary
5. **SessionEnd** - Marks session complete

## Testing

```bash
bun test
```

## Architecture

See `docs/architecture/` for detailed documentation:

- `REBUILD_GUIDE.md` - Step-by-step rebuild guide
- `HOOKS.md` - Hook system documentation
- `DATABASE.md` - Database schema and FTS setup
- `SDK_AGENT.md` - SDK agent and prompt templates

## Requirements

- **Runtime:** Bun
- **Database:** SQLite with FTS5 (built-in)
- **Claude Code:** For hook integration
