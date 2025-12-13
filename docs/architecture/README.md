# Claude-Mem Architecture Documentation

This directory contains comprehensive documentation for the claude-mem plugin architecture, providing sufficient detail to rebuild the project from scratch.

## Documentation Index

| Document | Description |
|----------|-------------|
| [ARCHITECTURE_OVERVIEW.md](./ARCHITECTURE_OVERVIEW.md) | High-level system overview, component diagram, and data flow |
| [HOOKS.md](./HOOKS.md) | Hook system lifecycle, implementations, and configuration |
| [DATABASE.md](./DATABASE.md) | SQLite schema, FTS5 search, migrations, and queries |
| [SDK_AGENT.md](./SDK_AGENT.md) | AI processing, prompt engineering, and XML parsing |
| [REBUILD_GUIDE.md](./REBUILD_GUIDE.md) | Step-by-step guide to rebuild from scratch |

## Quick Navigation

### Understanding the System
1. Start with [ARCHITECTURE_OVERVIEW.md](./ARCHITECTURE_OVERVIEW.md) for the big picture
2. Read [HOOKS.md](./HOOKS.md) to understand how Claude Code events are captured
3. Review [DATABASE.md](./DATABASE.md) to understand data persistence
4. Study [SDK_AGENT.md](./SDK_AGENT.md) to understand AI processing

### Rebuilding the System
1. Follow [REBUILD_GUIDE.md](./REBUILD_GUIDE.md) for step-by-step instructions
2. Reference individual docs for implementation details

### Extending the System
1. For new hooks: see [HOOKS.md](./HOOKS.md)
2. For schema changes: see [DATABASE.md](./DATABASE.md)
3. For prompt changes: see [SDK_AGENT.md](./SDK_AGENT.md)

## System Summary

Claude-mem is a persistent memory system for Claude Code that:

```
┌───────────────────────────────────────────────────────────────────┐
│                      Data Flow                                     │
│                                                                    │
│  Claude Code Session                                               │
│       │                                                            │
│       ├─► PostToolUse Hook ─► Worker ─► SDK Agent ─► Database     │
│       │                                                            │
│       └─► SessionStart Hook ◄── Context Injection ◄── Database    │
│                                                                    │
└───────────────────────────────────────────────────────────────────┘
```

**Key Components:**
- **Hooks** - Thin HTTP clients that capture Claude Code lifecycle events
- **Worker Service** - HTTP server managing sessions and processing
- **SDK Agent** - Claude AI subprocess for semantic extraction
- **Database** - SQLite with FTS5 for persistent storage and search

**Key Design Decisions:**
- Hooks have no native dependencies (works on Node or Bun)
- Fire-and-forget pattern (hooks don't block Claude Code)
- Event-driven processing (no polling)
- All hooks use same `session_id` for threading
- Privacy tags stripped before storage

## Version

- **Version:** 7.0.0
- **Runtime:** Bun
- **Last Updated:** December 2025
