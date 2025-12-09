# Database Schema Documentation

**Database:** SQLite with WAL mode
**Location:** `~/.claude-mem/claude-mem.db`
**Runtime:** bun:sqlite (Bun's built-in SQLite)

## Schema Overview

The database uses a migration system with 7 migrations. The current active tables are:

```
┌─────────────────┐     ┌──────────────────┐     ┌───────────────────┐
│  sdk_sessions   │◄────│   observations   │     │ session_summaries │
│  (session meta) │     │ (tool captures)  │     │ (end summaries)   │
└─────────────────┘     └──────────────────┘     └───────────────────┘
        ▲                       │                        │
        │                       ▼                        ▼
        │               ┌──────────────────┐     ┌───────────────────┐
        │               │ observations_fts │     │session_summaries  │
        │               │   (FTS5 search)  │     │      _fts         │
        │               └──────────────────┘     └───────────────────┘
        │
┌───────┴─────────┐     ┌──────────────────┐
│  user_prompts   │     │  user_prompts    │
│ (user messages) │────►│      _fts        │
└─────────────────┘     └──────────────────┘
```

## Core Tables

### sdk_sessions

Tracks Claude Code sessions and their SDK processing status.

```sql
CREATE TABLE sdk_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  claude_session_id TEXT UNIQUE NOT NULL,  -- From Claude Code
  sdk_session_id TEXT UNIQUE,               -- Generated UUID
  project TEXT NOT NULL,                    -- Project name (from cwd)
  user_prompt TEXT,                         -- First user prompt
  started_at TEXT NOT NULL,                 -- ISO timestamp
  started_at_epoch INTEGER NOT NULL,        -- Unix ms timestamp
  completed_at TEXT,                        -- ISO timestamp
  completed_at_epoch INTEGER,               -- Unix ms timestamp
  status TEXT CHECK(status IN ('active', 'completed', 'failed')) NOT NULL DEFAULT 'active',
  worker_port INTEGER,                      -- Port worker was running on
  prompt_counter INTEGER DEFAULT 1          -- Current prompt number
);

-- Indexes
CREATE INDEX idx_sdk_sessions_claude_id ON sdk_sessions(claude_session_id);
CREATE INDEX idx_sdk_sessions_sdk_id ON sdk_sessions(sdk_session_id);
CREATE INDEX idx_sdk_sessions_project ON sdk_sessions(project);
CREATE INDEX idx_sdk_sessions_status ON sdk_sessions(status);
CREATE INDEX idx_sdk_sessions_started ON sdk_sessions(started_at_epoch DESC);
```

**Key Fields:**
- `claude_session_id` - Unique identifier from Claude Code (source of truth for session threading)
- `sdk_session_id` - UUID generated when SDK agent processes the session
- `status` - 'active' while processing, 'completed' when done, 'failed' on error
- `prompt_counter` - Tracks how many user prompts in this session

### observations

Stores processed observations extracted by the SDK agent.

```sql
CREATE TABLE observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sdk_session_id TEXT NOT NULL,             -- FK to sdk_sessions
  project TEXT NOT NULL,
  text TEXT,                                -- Raw/legacy text (nullable)
  type TEXT NOT NULL CHECK(type IN ('decision', 'bugfix', 'feature', 'refactor', 'discovery', 'change')),
  title TEXT,                               -- Short title
  subtitle TEXT,                            -- One-line summary
  narrative TEXT,                           -- Detailed explanation
  facts TEXT,                               -- JSON array of facts
  concepts TEXT,                            -- JSON array of concepts
  files_read TEXT,                          -- JSON array of files read
  files_modified TEXT,                      -- JSON array of files modified
  prompt_number INTEGER,                    -- Which prompt this observation is from
  discovery_tokens INTEGER DEFAULT 0,       -- Token cost (ROI metric)
  created_at TEXT NOT NULL,
  created_at_epoch INTEGER NOT NULL,
  FOREIGN KEY(sdk_session_id) REFERENCES sdk_sessions(sdk_session_id) ON DELETE CASCADE
);

-- Indexes
CREATE INDEX idx_observations_sdk_session ON observations(sdk_session_id);
CREATE INDEX idx_observations_project ON observations(project);
CREATE INDEX idx_observations_type ON observations(type);
CREATE INDEX idx_observations_created ON observations(created_at_epoch DESC);
```

**Observation Types:**
- `decision` - Architectural or design decisions
- `bugfix` - Bug fixes and their solutions
- `feature` - New feature implementations
- `refactor` - Code refactoring
- `discovery` - Discovered facts about the codebase
- `change` - Generic changes (default when type is missing/invalid)

**Hierarchical Fields:**
- `title` - Short title (e.g., "Fixed authentication bug")
- `subtitle` - One-liner (e.g., "Token validation was missing null check")
- `narrative` - Full explanation of what was done and why
- `facts` - JSON array of bullet-point facts
- `concepts` - JSON array of concept tags for categorization
- `files_read` / `files_modified` - JSON arrays of file paths

### observations_fts (FTS5 Virtual Table)

Full-text search index for observations.

```sql
CREATE VIRTUAL TABLE observations_fts USING fts5(
  title,
  subtitle,
  narrative,
  text,
  facts,
  concepts,
  content='observations',
  content_rowid='id'
);

-- Triggers for sync
CREATE TRIGGER observations_ai AFTER INSERT ON observations ...
CREATE TRIGGER observations_ad AFTER DELETE ON observations ...
CREATE TRIGGER observations_au AFTER UPDATE ON observations ...
```

### session_summaries

End-of-session summaries generated by the SDK agent.

```sql
CREATE TABLE session_summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sdk_session_id TEXT NOT NULL,             -- FK (not unique - multiple summaries possible)
  project TEXT NOT NULL,
  request TEXT,                             -- What user asked for
  investigated TEXT,                        -- What was investigated
  learned TEXT,                             -- What was learned
  completed TEXT,                           -- What was completed
  next_steps TEXT,                          -- Suggested next steps
  files_read TEXT,                          -- JSON array of files read
  files_edited TEXT,                        -- JSON array of files edited
  notes TEXT,                               -- Additional notes
  prompt_number INTEGER,                    -- Which prompt this summary is from
  discovery_tokens INTEGER DEFAULT 0,       -- Token cost (ROI metric)
  created_at TEXT NOT NULL,
  created_at_epoch INTEGER NOT NULL,
  FOREIGN KEY(sdk_session_id) REFERENCES sdk_sessions(sdk_session_id) ON DELETE CASCADE
);

-- Indexes
CREATE INDEX idx_session_summaries_sdk_session ON session_summaries(sdk_session_id);
CREATE INDEX idx_session_summaries_project ON session_summaries(project);
CREATE INDEX idx_session_summaries_created ON session_summaries(created_at_epoch DESC);
```

### session_summaries_fts (FTS5 Virtual Table)

Full-text search index for session summaries.

```sql
CREATE VIRTUAL TABLE session_summaries_fts USING fts5(
  request,
  investigated,
  learned,
  completed,
  next_steps,
  notes,
  content='session_summaries',
  content_rowid='id'
);
```

### user_prompts

Stores user prompts (with privacy tags stripped).

```sql
CREATE TABLE user_prompts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  claude_session_id TEXT NOT NULL,          -- FK to sdk_sessions
  prompt_number INTEGER NOT NULL,           -- Sequential prompt number
  prompt_text TEXT NOT NULL,                -- Cleaned prompt text
  created_at TEXT NOT NULL,
  created_at_epoch INTEGER NOT NULL,
  FOREIGN KEY(claude_session_id) REFERENCES sdk_sessions(claude_session_id) ON DELETE CASCADE
);

-- Indexes
CREATE INDEX idx_user_prompts_claude_session ON user_prompts(claude_session_id);
CREATE INDEX idx_user_prompts_created ON user_prompts(created_at_epoch DESC);
```

### user_prompts_fts (FTS5 Virtual Table)

Full-text search index for user prompts.

```sql
CREATE VIRTUAL TABLE user_prompts_fts USING fts5(
  prompt_text,
  content='user_prompts',
  content_rowid='id'
);
```

## Legacy Tables (Unused)

These tables exist from earlier migrations but are no longer used:

- `sessions` - Original session tracking (replaced by sdk_sessions)
- `memories` - Original memory storage (replaced by observations)
- `overviews` - Original summaries (replaced by session_summaries)
- `diagnostics` - Debug logging
- `transcript_events` - Raw transcript storage

## Migration History

| Version | Description |
|---------|-------------|
| 1 | Initial schema (sessions, memories, overviews, diagnostics, transcript_events) |
| 2 | Added hierarchical fields to memories (title, subtitle, facts, concepts) |
| 3 | Added streaming_sessions table |
| 4 | Added SDK agent tables (sdk_sessions, observation_queue, observations, session_summaries) |
| 5 | Dropped orphaned tables (streaming_sessions, observation_queue) |
| 6 | Added FTS5 full-text search tables and triggers |
| 7 | Added discovery_tokens column for ROI tracking |

## Database Operations

### SessionStore Methods

**Session Management:**
```typescript
createSDKSession(claudeSessionId: string, project: string, userPrompt: string): number
getSessionByClaudeId(claudeSessionId: string): SDKSessionRow | undefined
markSessionCompleted(sessionDbId: number): void
incrementPromptCounter(sessionDbId: number): number
getPromptCounter(sessionDbId: number): number
```

**Observation Storage:**
```typescript
storeObservation(
  sdkSessionId: string,
  project: string,
  observation: ParsedObservation,
  promptNumber: number,
  discoveryTokens?: number
): number

getRecentObservations(project: string, limit: number): ObservationRow[]
getObservationById(id: number): ObservationRow | undefined
```

**Summary Storage:**
```typescript
storeSummary(
  sdkSessionId: string,
  project: string,
  summary: ParsedSummary,
  promptNumber: number,
  discoveryTokens?: number
): number

getRecentSummaries(project: string, limit: number): SessionSummaryRow[]
```

**User Prompts:**
```typescript
saveUserPrompt(claudeSessionId: string, promptNumber: number, promptText: string): number
getUserPrompts(claudeSessionId: string): UserPromptRow[]
```

### SessionSearch Methods

**Full-Text Search:**
```typescript
searchObservations(query: string, project?: string, limit?: number): ObservationSearchResult[]
searchSessions(query: string, project?: string, limit?: number): SessionSummarySearchResult[]
searchPrompts(query: string, project?: string, limit?: number): UserPromptSearchResult[]
```

**Filtered Queries:**
```typescript
findByType(types: string[], project?: string, limit?: number): ObservationSearchResult[]
findByConcept(concepts: string[], project?: string, limit?: number): ObservationSearchResult[]
findByFile(filePaths: string[], project?: string, limit?: number): ObservationSearchResult[]
```

**Timeline:**
```typescript
getTimeline(
  anchor: number | string,  // observation ID, "S{id}" for session, or ISO timestamp
  depthBefore: number,
  depthAfter: number,
  project?: string
): TimelineItem[]
```

## FTS5 Search Syntax

SQLite FTS5 supports these query patterns:

```sql
-- Simple word search
SELECT * FROM observations_fts WHERE observations_fts MATCH 'authentication';

-- Phrase search
SELECT * FROM observations_fts WHERE observations_fts MATCH '"token validation"';

-- Column-specific search
SELECT * FROM observations_fts WHERE observations_fts MATCH 'title:bugfix';

-- AND/OR/NOT
SELECT * FROM observations_fts WHERE observations_fts MATCH 'bug AND fix';
SELECT * FROM observations_fts WHERE observations_fts MATCH 'error OR exception';
SELECT * FROM observations_fts WHERE observations_fts MATCH 'auth NOT password';

-- Prefix matching
SELECT * FROM observations_fts WHERE observations_fts MATCH 'auth*';

-- Ranking by relevance
SELECT *, rank FROM observations_fts WHERE observations_fts MATCH 'query' ORDER BY rank;
```

## Database Initialization

```typescript
// Database.ts
import { Database } from 'bun:sqlite';

class DatabaseManager {
  private db: Database;

  async initialize(): Promise<void> {
    const dbPath = path.join(DATA_DIR, 'claude-mem.db');
    this.db = new Database(dbPath);

    // Enable WAL mode for better concurrency
    this.db.run('PRAGMA journal_mode = WAL');
    this.db.run('PRAGMA synchronous = NORMAL');
    this.db.run('PRAGMA cache_size = -64000');  // 64MB cache
    this.db.run('PRAGMA temp_store = MEMORY');
    this.db.run('PRAGMA mmap_size = 268435456'); // 256MB mmap

    // Run migrations
    this.runMigrations();
  }

  private runMigrations(): void {
    // Create migrations table
    this.db.run(`
      CREATE TABLE IF NOT EXISTS migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      )
    `);

    // Get current version
    const current = this.db.query('SELECT MAX(version) as v FROM migrations').get() as { v: number } | null;
    const currentVersion = current?.v || 0;

    // Apply pending migrations
    for (const migration of migrations) {
      if (migration.version > currentVersion) {
        migration.up(this.db);
        this.db.run(
          'INSERT INTO migrations (version, applied_at) VALUES (?, ?)',
          [migration.version, new Date().toISOString()]
        );
      }
    }
  }
}
```

## Data Retention

Currently no automatic data retention is implemented. Manual cleanup:

```sql
-- Delete observations older than 30 days
DELETE FROM observations
WHERE created_at_epoch < (strftime('%s', 'now') - 30*24*60*60) * 1000;

-- Delete completed sessions older than 30 days
DELETE FROM sdk_sessions
WHERE status = 'completed'
AND completed_at_epoch < (strftime('%s', 'now') - 30*24*60*60) * 1000;

-- Rebuild FTS indexes after deletion
INSERT INTO observations_fts(observations_fts) VALUES('rebuild');
INSERT INTO session_summaries_fts(session_summaries_fts) VALUES('rebuild');
```

## Timestamps

All timestamps are stored in two formats:
- `created_at` / `started_at` / `completed_at` - ISO 8601 string
- `created_at_epoch` / `started_at_epoch` / `completed_at_epoch` - Unix timestamp in milliseconds

**Important:** Epoch timestamps are in **milliseconds**, not seconds:
```typescript
const date = new Date(row.created_at_epoch);  // Correct
const date = new Date(row.created_at_epoch * 1000);  // Wrong (already in ms)
```
