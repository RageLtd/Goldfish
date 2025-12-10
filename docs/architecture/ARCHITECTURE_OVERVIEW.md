# Claude-Mem Architecture Overview

**Version:** 7.0.0
**Runtime:** Bun
**Purpose:** Persistent memory system for Claude Code that captures, processes, and recalls observations across sessions.

## System Overview

Claude-mem is a plugin for Claude Code that provides persistent memory by:
1. **Capturing** tool executions (observations) via lifecycle hooks
2. **Processing** observations through Claude SDK to extract semantic meaning
3. **Storing** processed data in SQLite with FTS5 full-text search
4. **Injecting** relevant context back into new sessions

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           Claude Code Session                            │
│                                                                          │
│  User Prompt → Tool Use → Tool Response → Next Tool Use → ... → Stop    │
└─────────────────────────────────────────────────────────────────────────┘
        │              │                                           │
        │              │ PostToolUse                               │ Stop
        │              ▼                                           ▼
┌───────┴──────────────────────────────────────────────────────────────────┐
│                             Hook Layer                                    │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐ │
│  │ context-hook │  │  save-hook   │  │ summary-hook │  │ cleanup-hook │ │
│  │ (SessionStart)│  │(PostToolUse) │  │   (Stop)     │  │ (SessionEnd) │ │
│  └──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘ │
└────────│─────────────────│──────────────────│─────────────────│─────────┘
         │                 │                  │                 │
         │   HTTP (fire-and-forget)          │                 │
         ▼                 ▼                  ▼                 ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                        Worker Service (auto-started)                     │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐          │
│  │ SessionManager  │  │    SDKAgent     │  │  SearchManager  │          │
│  │ (state/queues)  │  │ (Claude SDK)    │  │ (FTS5+Chroma)   │          │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘          │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────┐        │
│  │                     SQLite Database                          │        │
│  │  ┌───────────────┐ ┌───────────────┐ ┌───────────────┐      │        │
│  │  │ sdk_sessions  │ │ observations  │ │session_summaries│     │        │
│  │  └───────────────┘ └───────────────┘ └───────────────┘      │        │
│  └─────────────────────────────────────────────────────────────┘        │
└─────────────────────────────────────────────────────────────────────────┘
```

## Core Components

### 1. Hook Layer (Thin HTTP Clients)
Hooks run in the Claude Code process and make HTTP calls to the worker service.

| Hook | Trigger | Purpose |
|------|---------|---------|
| `context-hook` | SessionStart | Inject recent observations into new sessions |
| `new-hook` | SessionStart | Record new session with first user prompt |
| `save-hook` | PostToolUse | Capture tool executions as observations |
| `summary-hook` | Stop | Generate end-of-session summary |
| `cleanup-hook` | SessionEnd | Mark session complete, cleanup resources |
| `user-message-hook` | UserPromptSubmit | Track user message metadata |

### 2. Worker Service (Background Process)
Express HTTP server auto-started by hooks, running on Bun runtime.

**Domain Services:**
- `SessionManager` - In-memory session state and message queues
- `SDKAgent` - Claude SDK subprocess for AI processing
- `SearchManager` - Hybrid search (FTS5 + Chroma vectors)
- `FormattingService` - Context formatting for injection
- `SSEBroadcaster` - Real-time updates to UI

**HTTP Routes:**
- `/api/sessions/*` - Session lifecycle
- `/api/observations`, `/api/summaries` - Data retrieval
- `/api/search/*` - Search operations
- `/api/context/*` - Context generation
- `/api/settings/*` - Configuration

### 3. Database Layer (SQLite + FTS5)
Single SQLite database with WAL mode for performance.

**Tables:**
- `sdk_sessions` - Session metadata
- `observations` - Captured and processed tool observations
- `observations_fts` - Full-text search virtual table
- `session_summaries` - End-of-session summaries
- `session_summaries_fts` - Summary search virtual table
- `user_prompts` - User message history
- `user_prompts_fts` - Prompt search virtual table

### 4. SDK Agent (AI Processing)
Uses Anthropic Agent SDK to spawn Claude subprocess for:
- Extracting semantic meaning from tool observations
- Generating session summaries
- Classifying observation types

## Data Flow: Observation Lifecycle

```
1. USER PROMPT
   └─► Claude Code receives user prompt

2. TOOL EXECUTION
   └─► Claude Code executes tool (Bash, Read, Write, etc.)

3. HOOK CAPTURE (save-hook)
   ├─► Strip <private> and <claude-mem-context> tags
   ├─► Skip if tool in SKIP_TOOLS list
   └─► HTTP POST to /api/sessions/observations

4. WORKER PROCESSING
   ├─► SessionManager.initializeSession() - create/retrieve session
   ├─► Queue message for SDK processing
   └─► Start SDK agent if not running

5. SDK AGENT PROCESSING
   ├─► Claude analyzes tool execution via prompts
   ├─► Extracts: type, title, narrative, facts, concepts, files
   └─► Returns XML observation blocks

6. STORAGE
   ├─► SessionStore.storeObservation() - save to SQLite
   ├─► FTS5 triggers update search index
   └─► ChromaSync - update vector embeddings

7. BROADCAST
   └─► SSEBroadcaster pushes update to UI
```

## Key Design Patterns

### Fire-and-Forget Hooks
Hooks return immediately after making HTTP call. Worker processes asynchronously.
```typescript
// Hook doesn't wait for processing
await fetch('/api/sessions/observations', { method: 'POST', body });
return { success: true }; // Immediate response
```

### Event-Driven Sessions
SessionManager uses EventEmitter per session for message coordination.
```typescript
const session = {
  sessionDbId: 123,
  pendingMessages: [],
  emitter: new EventEmitter()
};
// Messages queued, SDK agent pulls when ready
```

### Edge Processing (Privacy)
Tags stripped at hook layer before reaching worker.
```typescript
// In save-hook
const cleanInput = stripMemoryTags(JSON.stringify(tool_input));
// <private> and <claude-mem-context> content removed
```

### Progressive Context Injection
Context generation respects token limits and user preferences.
```typescript
// Layered context: summaries → recent observations → full details
const context = formatContext({
  summaries: recentSummaries.slice(0, sessionCount),
  observations: recentObs.slice(0, obsCount),
  fullObservations: recentObs.slice(0, fullCount)
});
```

## Configuration

### Environment Variables
```bash
CLAUDE_MEM_PORT=3456              # Worker HTTP port (default: 3456)
CLAUDE_MEM_DB=~/.claude-mem/memory.db  # Database path
CLAUDE_MEM_MODEL=claude-haiku-4-5 # SDK model
CLAUDE_MEM_LOG_LEVEL=INFO         # Logging level
```

### Settings File (~/.claude-mem/settingson)
```json
{
  "env": {
    "CLAUDE_MEM_CONTEXT_OBSERVATIONS": "50",
    "CLAUDE_MEM_CONTEXT_FULL_COUNT": "5",
    "CLAUDE_MEM_CONTEXT_SESSION_COUNT": "10"
  }
}
```

## File Organization

```
claude-mem-bun/
├── src/                          # TypeScript source
│   ├── hooks/                    # Lifecycle hook implementations
│   ├── services/
│   │   ├── worker-service.ts     # Express server entry
│   │   ├── worker/               # Domain services
│   │   │   ├── SessionManager.ts
│   │   │   ├── SDKAgent.ts
│   │   │   ├── SearchManager.ts
│   │   │   └── http/routes/      # API route handlers
│   │   └── sqlite/               # Database layer
│   │       ├── Database.ts
│   │       ├── SessionStore.ts
│   │       ├── SessionSearch.ts
│   │       └── migrations.ts
│   ├── sdk/                      # Claude SDK integration
│   │   ├── prompts.ts            # Prompt templates
│   │   └── parser.ts             # XML response parsing
│   └── servers/
│       └── mcp-server.ts         # MCP search server
├── plugin/                       # Built/compiled plugin
│   ├── hooks/hookson          # Hook configuration
│   └── scripts/                  # Compiled JavaScript
├── scripts/                      # Build scripts
│   ├── build-hooks            # Bun.build() orchestrator
│   └── build-viewer           # React viewer bundler
├── tests/                        # Test suites
└── package.json
```

## Related Documentation

- [Hook System](./HOOKS.md) - Detailed hook lifecycle and implementation
- [Worker Service](./WORKER_SERVICE.md) - API endpoints and domain services
- [Database Schema](./DATABASE.md) - Tables, migrations, and queries
- [SDK Agent](./SDK_AGENT.md) - AI processing and prompt engineering
- [MCP Server](./MCP_SERVER.md) - Model Context Protocol integration
- [Build System](./BUILD.md) - Bun build configuration
