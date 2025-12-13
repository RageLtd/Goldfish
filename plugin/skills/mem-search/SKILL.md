---
name: mem-search
description: Search project memory for past observations, decisions, and session history. Use when asked about previous work, past decisions, what was done before, or searching project history.
---

# Memory Search Skill

Search the claude-mem database for observations, decisions, summaries, and session history from past work.

## Progressive Disclosure

Context is loaded using **progressive disclosure** for token efficiency:

1. **Index tier** (default): Lightweight semantic index (~20 tokens/observation)
2. **Detail tier**: Full observation content fetched on-demand by ID

**Token Economics:**
- Loading 50 observations as index: ~1,100 tokens
- Loading 50 observations full: ~7,500 tokens
- **Savings: ~85% reduction**

The index format shows:
| ID | Time | T | Title | Read | Work |
|----|------|---|-------|------|------|
| #201 | 8:00 PM | discovery | API structure analysis | ~563 | 4,956 |

- **Read**: Tokens to fetch full content (cost to learn details)
- **Work**: Tokens spent on work that produced this record

## When to Use

- User asks about past work: "What did we do yesterday?", "What decisions did we make?"
- User searches for context: "What do you know about authentication?", "Find previous work on the API"
- User asks about files: "What changes were made to user.ts?", "Show history for this file"
- User asks about decisions: "Why did we choose this approach?", "What architectural decisions?"
- You need implementation details from an observation in the index

## API Endpoints

The worker service runs on `http://localhost:3456`. Use curl to query it.

### Get Recent Context

```bash
curl -s "http://localhost:3456/context?project=PROJECT&limit=LIMIT&format=FORMAT&since=SINCE"
```

Parameters:
- `project` (required): Project name
- `limit`: Max results (default: 10, max: 100)
- `format`: `index` (default) or `full` - controls disclosure level
- `since`: Time filter (see Temporal Queries below)

### Fetch Single Observation (Detail Tier)

```bash
curl -s "http://localhost:3456/observation_by_id?id=ID"
```

Use this to fetch full details for a specific observation from the index.

Parameters:
- `id` (required): Observation ID (from index)

Response:
```json
{
  "observation": { /* full observation data */ },
  "formatted": "## discovery API structure analysis\n..."
}
```

### Search Observations/Summaries

```bash
curl -s "http://localhost:3456/search?query=QUERY&type=TYPE&concept=CONCEPT&project=PROJECT&limit=LIMIT"
```

Parameters:
- `query` (required): Search text
- `type`: `observations` or `summaries` (default: observations)
- `concept`: Filter by taxonomy concept (e.g., `decision`, `bugfix`, `feature`, `refactor`, `discovery`, `change`)
- `project`: Filter by project name
- `limit`: Max results (default: 10, max: 100)

**Concept-based search** improves relevance by filtering to observations tagged with specific taxonomy concepts. Use this to find:
- `decision` - Architectural and design decisions
- `bugfix` - Bug fixes and issue resolutions
- `feature` - New functionality implementations
- `refactor` - Code restructuring
- `discovery` - Research and exploration findings
- `change` - General code modifications

### Get Timeline

```bash
curl -s "http://localhost:3456/timeline?limit=LIMIT&since=SINCE"
curl -s "http://localhost:3456/timeline?project=PROJECT&limit=LIMIT&since=SINCE"
```

Returns chronological list of recent activity (observations and summaries merged).

Parameters:
- `project` (optional): Filter by project name
- `limit`: Max results (default: 10, max: 100)
- `since`: Time filter

### Get Decisions

```bash
curl -s "http://localhost:3456/decisions?limit=LIMIT&since=SINCE"
curl -s "http://localhost:3456/decisions?project=PROJECT&limit=LIMIT&since=SINCE"
```

Returns architectural and design decisions (filters for type=decision observations).

Parameters:
- `project` (optional): Filter by project name
- `limit`: Max results (default: 10, max: 100)
- `since`: Time filter

### Find by File

```bash
curl -s "http://localhost:3456/find_by_file?file=FILEPATH&limit=LIMIT"
```

Returns observations related to a specific file (searches filesRead and filesModified).

Parameters:
- `file` (required): File path or partial path to search for
- `limit`: Max results (default: 10, max: 100)

## Temporal Queries

The `since` parameter supports multiple formats:

| Format | Example | Description |
|--------|---------|-------------|
| Keywords | `today`, `yesterday` | Start of day |
| Days | `7d`, `30d` | N days ago |
| Weeks | `2w`, `4w` | N weeks ago |
| ISO date | `2024-01-15` | Specific date |
| Epoch | `1704067200` | Unix timestamp |

Examples:
```bash
# Get context from today only
curl -s "http://localhost:3456/context?project=myapp&since=today"

# Get decisions from the last week
curl -s "http://localhost:3456/decisions?since=7d"

# Get timeline since a specific date
curl -s "http://localhost:3456/timeline?since=2024-12-01"
```

## Response Format

Context endpoint returns:
```json
{
  "context": "# project recent context\n...",
  "observationCount": 10,
  "summaryCount": 3,
  "format": "index"
}
```

Search/Timeline/Decisions return:
```json
{
  "results": [...],
  "count": 5
}
```

## Example Workflow

1. **Start with index** (automatic on session start):
   - Review observation titles, types, and token estimates
   - Understand what past work exists

2. **Fetch details on-demand**:
   ```bash
   # Observation #201 looks relevant, fetch full content
   curl -s "http://localhost:3456/observation_by_id?id=201"
   ```

3. **Use temporal queries for focus**:
   ```bash
   # What happened today?
   curl -s "http://localhost:3456/context?project=myapp&since=today"

   # Get decisions from last week
   curl -s "http://localhost:3456/decisions?since=7d&format=full"
   ```

## Type Icons

| Icon | Type | Description |
|------|------|-------------|
| session | Session summary | End-of-session learnings |
| bugfix | Bug fix | Issue resolutions |
| feature | Feature | New functionality |
| refactor | Refactor | Code restructuring |
| change | Change | General modifications |
| discovery | Discovery | Research findings |
| decision | Decision | Architectural choices |

## Tips

- **Trust the index**: Titles and types often provide enough context
- **Fetch selectively**: Only fetch full observations when you need implementation details
- **Use temporal filters**: `?since=today` or `?since=7d` to narrow scope
- **Check decisions first**: For "why" questions, decision observations are most valuable
- **Use file search**: When working on a specific file, find related past work
- **Use concept filtering**: Add `&concept=decision` to search for specific types of observations
