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

### As a Claude Code Plugin

1. Add the marketplace:
```bash
/plugin marketplace add https://github.com/RageLtd/claude-mem
```

2. Install the plugin:
```bash
/plugin install claude-mem-bun@rageltd
```

3. Restart Claude Code

On first session start, the plugin automatically downloads the correct binary for your platform.

### Supported Platforms

- macOS ARM64 (M1/M2/M3)
- macOS x64 (Intel)
- Linux x64
- Linux ARM64

## Plugin Structure

```
plugin/
├── .claude-plugin/
│   └── plugin.json           # Plugin manifest
├── bin/
│   └── claude-mem            # Binary (downloaded at runtime)
├── hooks/
│   └── hooks.json            # Lifecycle hook configuration
├── scripts/
│   └── ensure-binary.sh      # Binary download script
└── skills/
    └── mem-search/
        └── SKILL.md          # Memory search skill
```

## Hook Lifecycle

| Hook | Command | Purpose |
|------|---------|---------|
| SessionStart | `hook:context` | Inject relevant past context |
| UserPromptSubmit | `hook:new` | Create/update session |
| PostToolUse | `hook:save` | Capture tool executions |
| Stop | `hook:summary` | Generate session summary |
| SessionEnd | `hook:cleanup` | Mark session complete |

## Development

### Prerequisites

- [Bun](https://bun.sh) runtime
- Claude Code with the plugin installed

### Setup

```bash
# Install dependencies
bun install

# Run tests
bun test

# Type check
bun run tsc --noEmit
```

### Build & Install Locally

After making changes, build and install to the local plugin cache:

```bash
bun run dev:install
```

Then restart Claude Code to pick up the changes.

### CLI Commands

```bash
./plugin/bin/claude-mem hook:context   # SessionStart - inject context
./plugin/bin/claude-mem hook:new       # UserPromptSubmit - create session
./plugin/bin/claude-mem hook:save      # PostToolUse - save observations
./plugin/bin/claude-mem hook:summary   # Stop - generate summary
./plugin/bin/claude-mem hook:cleanup   # SessionEnd - cleanup
./plugin/bin/claude-mem worker         # Start HTTP worker service
./plugin/bin/claude-mem mcp            # Start MCP server (stdio)
./plugin/bin/claude-mem version        # Show version
```

### Worker Service

The worker service starts automatically when hooks are invoked. To run manually:

```bash
./plugin/bin/claude-mem worker
# or
bun run worker:start
```

## Releasing

Releases are fully automated via GitHub Actions using conventional commits.

### Automatic Versioning

Version bumps are determined by commit message prefixes:

| Prefix | Version Bump | Example |
|--------|--------------|---------|
| `feat!:` or `BREAKING CHANGE:` | **major** | `feat!: redesign API` |
| `feat:` | **minor** | `feat: add search feature` |
| `fix:`, `refactor:`, `perf:`, etc. | **patch** | `fix: correct typo` |
| `docs:`, `chore:` | **none** | `docs: update readme` |

### Workflow

1. **On PR:** CI shows a version preview of what will be released when merged
2. **On merge to main:**
   - Commits are analyzed for version bump type
   - `package.json` version is updated
   - Git tag is created and pushed
   - Binaries are built for all platforms
   - GitHub Release is created with binaries

### Manual Release (Dry Run)

Preview what version bump would occur:
```bash
bun run release:dry
```

### Release Binaries

Each release includes pre-built binaries:
- `claude-mem-darwin-arm64` - macOS Apple Silicon
- `claude-mem-darwin-x64` - macOS Intel
- `claude-mem-linux-x64` - Linux x64
- `claude-mem-linux-arm64` - Linux ARM64

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

## License

MIT
