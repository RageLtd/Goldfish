# Claude-Mem Rebuild Guide

**Purpose:** Step-by-step guide to rebuild claude-mem from scratch using the architecture documentation.

## System Requirements

- **Runtime:** Bun (recommended)
- **Database:** SQLite with FTS5 support (built-in)
- **Vector DB:** ChromaDB (optional, for semantic search)
- **Process Manager:** PM2 (for worker service)
- **Claude Code:** For hook integration

## Architecture Summary

Claude-mem is a persistent memory system for Claude Code that:

1. **Captures** tool executions via lifecycle hooks
2. **Processes** observations through Claude AI to extract semantic meaning
3. **Stores** structured data in SQLite with full-text search
4. **Injects** relevant context back into new sessions

```
Claude Code ──► Hooks ──► Worker Service ──► SDK Agent ──► Database
                              │                              │
                              └──────────────────────────────┘
                                    Context Injection
```

## Phase 1: Core Data Model

### 1.1 Database Schema

Create SQLite database with these core tables:

```sql
-- Sessions table
CREATE TABLE sdk_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  claude_session_id TEXT UNIQUE NOT NULL,
  sdk_session_id TEXT UNIQUE,
  project TEXT NOT NULL,
  user_prompt TEXT,
  started_at TEXT NOT NULL,
  started_at_epoch INTEGER NOT NULL,
  completed_at TEXT,
  completed_at_epoch INTEGER,
  status TEXT CHECK(status IN ('active', 'completed', 'failed')) DEFAULT 'active',
  prompt_counter INTEGER DEFAULT 1
);

-- Observations table
CREATE TABLE observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sdk_session_id TEXT NOT NULL,
  project TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('decision', 'bugfix', 'feature', 'refactor', 'discovery', 'change')),
  title TEXT,
  subtitle TEXT,
  narrative TEXT,
  facts TEXT,           -- JSON array
  concepts TEXT,        -- JSON array
  files_read TEXT,      -- JSON array
  files_modified TEXT,  -- JSON array
  prompt_number INTEGER,
  discovery_tokens INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  created_at_epoch INTEGER NOT NULL,
  FOREIGN KEY(sdk_session_id) REFERENCES sdk_sessions(claude_session_id)
);

-- Session summaries table
CREATE TABLE session_summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sdk_session_id TEXT NOT NULL,
  project TEXT NOT NULL,
  request TEXT,
  investigated TEXT,
  learned TEXT,
  completed TEXT,
  next_steps TEXT,
  notes TEXT,
  prompt_number INTEGER,
  discovery_tokens INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  created_at_epoch INTEGER NOT NULL,
  FOREIGN KEY(sdk_session_id) REFERENCES sdk_sessions(claude_session_id)
);

-- User prompts table
CREATE TABLE user_prompts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  claude_session_id TEXT NOT NULL,
  prompt_number INTEGER NOT NULL,
  prompt_text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_at_epoch INTEGER NOT NULL,
  FOREIGN KEY(claude_session_id) REFERENCES sdk_sessions(claude_session_id)
);
```

### 1.2 Full-Text Search

Add FTS5 virtual tables:

```sql
-- Observations FTS
CREATE VIRTUAL TABLE observations_fts USING fts5(
  title, subtitle, narrative, text, facts, concepts,
  content='observations', content_rowid='id'
);

-- Session summaries FTS
CREATE VIRTUAL TABLE session_summaries_fts USING fts5(
  request, investigated, learned, completed, next_steps, notes,
  content='session_summaries', content_rowid='id'
);

-- Triggers for automatic sync (see DATABASE.md for full trigger SQL)
```

## Phase 2: Worker Service

### 2.1 Express HTTP Server

Create an Express server with these routes:

```typescript
// Core endpoints
app.get('/api/health', ...)
app.post('/api/sessions/observations', ...)    // Queue observation
app.post('/api/sessions/summarize', ...)       // Queue summary
app.post('/api/sessions/complete', ...)        // Mark complete
app.get('/api/context/inject', ...)            // Context for SessionStart

// Data endpoints
app.get('/api/observations', ...)              // List observations
app.get('/api/summaries', ...)                 // List summaries
app.get('/api/search', ...)                    // Unified search
```

### 2.2 Domain Services

Implement these core services:

```typescript
// SessionManager - In-memory session state and queues
class SessionManager {
  initializeSession(sessionDbId: number): ActiveSession
  queueObservation(sessionDbId: number, data: ObservationData): void
  queueSummarize(sessionDbId: number, lastUserMessage: string): void
  async *getMessageIterator(sessionDbId: number): AsyncIterableIterator<PendingMessage>
}

// SDKAgent - Claude AI processing
class SDKAgent {
  async startSession(session: ActiveSession): Promise<void>
  // Uses @anthropic-ai/claude-agent-sdk
}

// SessionStore - Database CRUD
class SessionStore {
  createSDKSession(claudeSessionId: string, project: string, userPrompt: string): number
  storeObservation(sdkSessionId: string, project: string, obs: ParsedObservation): number
  storeSummary(sdkSessionId: string, project: string, summary: ParsedSummary): number
}
```

### 2.3 PM2 Configuration

```javascript
// ecosystem.config.cjs
module.exports = {
  apps: [{
    name: 'claude-mem-worker',
    script: './plugin/scripts/worker-service.cjs',
    interpreter: 'bun',
    watch: true,
    ignore_watch: ['node_modules', 'logs', '*.db']
  }]
};
```

## Phase 3: Hook System

### 3.1 Hook Configuration

Create `plugin/hooks/hookson`:

```json
{
  "hooks": {
    "SessionStart": [{ "command": "bun ${CLAUDE_PLUGIN_ROOT}/scripts/context-hook" }],
    "UserPromptSubmit": [{ "command": "bun ${CLAUDE_PLUGIN_ROOT}/scripts/new-hook" }],
    "PostToolUse": [{ "matcher": "*", "hooks": [{ "command": "bun ${CLAUDE_PLUGIN_ROOT}/scripts/save-hook" }] }],
    "Stop": [{ "command": "bun ${CLAUDE_PLUGIN_ROOT}/scripts/summary-hook" }],
    "SessionEnd": [{ "command": "bun ${CLAUDE_PLUGIN_ROOT}/scripts/cleanup-hook" }]
  }
}
```

### 3.2 Hook Implementations

**Key Design Principles:**
- Hooks are thin HTTP clients (no database access)
- Fire-and-forget pattern (don't block Claude Code)
- All hooks use same `session_id` from Claude Code

```typescript
// save-hook.ts - PostToolUse
async function saveHook(input: PostToolUseInput) {
  const response = await fetch(`http://127.0.0.1:${port}/api/sessions/observations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      claudeSessionId: input.session_id,
      tool_name: input.tool_name,
      tool_input: input.tool_input,
      tool_response: input.tool_response,
      cwd: input.cwd
    })
  });
}

// context-hook.ts - SessionStart
async function contextHook(input: SessionStartInput) {
  const result = await fetch(`http://127.0.0.1:${port}/api/context/inject?project=${project}`);
  return {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: result
    }
  };
}
```

## Phase 4: SDK Agent

### 4.1 Prompt Templates

Create prompts that instruct Claude to be an **observer, not executor**:

```typescript
// buildInitPrompt - First user prompt
function buildInitPrompt(project: string, sessionId: string, userPrompt: string): string {
  return `You are Claude-Mem, a specialized observer tool...
    CRITICAL: Record what was LEARNED/BUILT/FIXED, not what you are doing.
    Focus on deliverables and capabilities.`;
}

// buildObservationPrompt - Each tool execution
function buildObservationPrompt(obs: Observation): string {
  return `<observed_from_primary_session>
    <what_happened>${obs.tool_name}</what_happened>
    <parameters>${JSON.stringify(obs.tool_input)}</parameters>
    <outcome>${JSON.stringify(obs.tool_output)}</outcome>
  </observed_from_primary_session>`;
}

// buildSummaryPrompt - End of session
function buildSummaryPrompt(session: SDKSession): string {
  return `PROGRESS SUMMARY CHECKPOINT...
    Write progress notes of what was done, what was learned, and what's next.`;
}
```

### 4.2 XML Parser

Parse observation and summary XML blocks:

```typescript
interface ParsedObservation {
  type: string;            // bugfix|feature|refactor|change|discovery|decision
  title: string | null;
  subtitle: string | null;
  facts: string[];
  narrative: string | null;
  concepts: string[];
  files_read: string[];
  files_modified: string[];
}

function parseObservations(text: string): ParsedObservation[] {
  const regex = /<observation>([\s\S]*?)<\/observation>/g;
  // Extract fields, validate type, filter concepts
  // ALWAYS save observations, even with missing fields
}
```

### 4.3 Event-Driven Processing

```typescript
// SDK Agent query loop
async function startSession(session: ActiveSession) {
  const queryResult = query({
    prompt: messageGenerator,
    options: {
      model: 'claude-haiku-4-5',
      disallowedTools: ['Bash', 'Read', 'Write', ...],  // Observer only
      abortController: session.abortController
    }
  });

  for await (const message of queryResult) {
    if (message.type === 'assistant') {
      await processSDKResponse(session, message.content);
    }
  }
}

// Message generator (event-driven)
async *createMessageGenerator(session) {
  yield { type: 'user', message: buildInitPrompt(...) };

  for await (const message of sessionManager.getMessageIterator(sessionDbId)) {
    if (message.type === 'observation') {
      yield { type: 'user', message: buildObservationPrompt(message) };
    } else if (message.type === 'summarize') {
      yield { type: 'user', message: buildSummaryPrompt(session) };
    }
  }
}
```

## Phase 5: MCP Server (Optional)

### 5.1 Tool Definitions

Expose search tools via MCP protocol:

```typescript
const tools = [
  { name: 'search', handler: (args) => callWorkerAPI('/api/search', args) },
  { name: 'timeline', handler: (args) => callWorkerAPI('/api/timeline', args) },
  { name: 'decisions', handler: (args) => callWorkerAPI('/api/decisions', args) },
  { name: 'find_by_file', handler: (args) => callWorkerAPI('/api/search/by-file', args) },
  // ...
];
```

### 5.2 MCP Protocol

```typescript
import { Server } from '@modelcontextprotocol/sdk/server/index';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio';

const server = new Server({ name: 'claude-mem-search-server', version: '1.0.0' });
server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [...] }));
server.setRequestHandler(CallToolRequestSchema, (request) => tools.find(t => t.name === request.params.name).handler(request.params.arguments));

await server.connect(new StdioServerTransport());
```

## Phase 6: Build System

### 6.1 Bun Build Configuration

```javascript
// scripts/build-hooks
const hookEntries = [
  { name: 'context-hook', source: 'src/hooks/context-hook.ts' },
  { name: 'save-hook', source: 'src/hooks/save-hook.ts' },
  // ...
];

for (const hook of hookEntries) {
  await Bun.build({
    entrypoints: [hook.source],
    outdir: 'plugin/scripts',
    target: 'bun',
    format: 'esm',
    minify: true
  });
}

// Worker service (CJS bundle)
await Bun.build({
  entrypoints: ['src/services/worker-service.ts'],
  outdir: 'plugin/scripts',
  target: 'bun',
  format: 'cjs',
  minify: true
});
```

### 6.2 Package.json Scripts

```json
{
  "scripts": {
    "build": "bun scripts/build-hooks",
    "test": "bun test tests/",
    "worker:start": "pm2 start ecosystem.config.cjs",
    "worker:restart": "pm2 restart claude-mem-worker",
    "worker:logs": "pm2 logs claude-mem-worker"
  }
}
```

## Key Implementation Details

### Session Threading
- All hooks receive same `session_id` from Claude Code
- Use this ID as the source of truth for session threading
- `createSDKSession()` is idempotent (INSERT OR IGNORE)

### Privacy Tags
- Strip `<private>` and `<claude-mem-context>` tags before storage
- Skip memory operations if entire prompt is private
- Implemented in `utils/tag-stripping.ts`

### Fire-and-Forget Pattern
- Hooks return immediately after HTTP call
- Worker processes asynchronously
- Use SSE for real-time UI updates

### Token Tracking
- Track `discovery_tokens` per observation/summary
- Includes input, output, and cache creation tokens
- Used for ROI metrics

### Error Handling
- Connection errors suggest worker restart
- HTTP errors thrown as-is
- Graceful degradation when worker unavailable

## Testing Strategy

```typescript
// Happy path tests
describe('observation-capture', () => {
  it('captures Bash command observation', async () => {
    global.fetch = mock(() => Promise.resolve({ ok: true, json: () => ({ status: 'queued' }) }));
    // Verify observation queued
  });
});

// Integration tests
describe('full-lifecycle', () => {
  it('captures observations and generates summary', async () => {
    // Test complete session flow
  });
});
```

## Directory Structure

```
claude-mem/
├── src/
│   ├── hooks/              # Hook implementations
│   ├── services/
│   │   ├── worker-service.ts
│   │   ├── worker/         # Domain services
│   │   └── sqlite/         # Database layer
│   ├── sdk/                # Prompts and parser
│   ├── servers/            # MCP server
│   └── utils/              # Shared utilities
├── plugin/
│   ├── hooks/hookson
│   └── scripts/            # Built JavaScript
├── scripts/                # Build scripts
├── tests/                  # Test suites
├── docs/architecture/      # This documentation
├── ecosystem.config.cjs    # PM2 config
└── packageon
```

## Quick Start Commands

```bash
# Install dependencies
bun install

# Build everything
bun run build

# Start worker
pm2 start ecosystem.config.cjs

# Run tests
bun test tests/

# View worker logs
pm2 logs claude-mem-worker
```
