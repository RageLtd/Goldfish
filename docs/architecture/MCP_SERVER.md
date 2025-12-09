# MCP Server Documentation

**Purpose:** Expose claude-mem search functionality to Claude Code via the Model Context Protocol (MCP).

## Architecture

The MCP server is a **thin HTTP wrapper** that delegates all business logic to the Worker HTTP API.

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         Claude Code                                      │
│                                                                          │
│  ┌─────────────────┐     ┌──────────────────┐     ┌──────────────────┐ │
│  │   MCP Client    │◄───►│  MCP Protocol    │◄───►│  Tool Invocation │ │
│  │   (Claude)      │     │  (stdio)         │     │                  │ │
│  └─────────────────┘     └──────────────────┘     └──────────────────┘ │
└─────────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                      MCP Search Server                                   │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │  Tool Handlers                                                    │   │
│  │  - search          → /api/search                                  │   │
│  │  - timeline        → /api/timeline                                │   │
│  │  - decisions       → /api/decisions                               │   │
│  │  - changes         → /api/changes                                 │   │
│  │  - how_it_works    → /api/how-it-works                            │   │
│  │  - find_by_concept → /api/search/by-concept                       │   │
│  │  - find_by_file    → /api/search/by-file                          │   │
│  │  - find_by_type    → /api/search/by-type                          │   │
│  └─────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼ HTTP
┌─────────────────────────────────────────────────────────────────────────┐
│                      Worker Service (port 37777)                         │
│                                                                          │
│  ┌─────────────────┐     ┌──────────────────┐     ┌──────────────────┐ │
│  │  SearchManager  │     │   SessionStore   │     │   ChromaSync     │ │
│  │  (FTS5+Vector)  │     │   (SQLite)       │     │  (Vector DB)     │ │
│  └─────────────────┘     └──────────────────┘     └──────────────────┘ │
└─────────────────────────────────────────────────────────────────────────┘
```

## MCP Protocol

The server uses the `@modelcontextprotocol/sdk` for MCP protocol handling:

```typescript
import { Server } from '@modelcontextprotocol/sdk/server/index';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types';

const server = new Server(
  { name: 'claude-mem-search-server', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

// Connect via stdio
const transport = new StdioServerTransport();
await server.connect(transport);
```

## Available Tools

### Primary Search Tools

#### `search`
Unified search across all memory types using vector-first semantic search.

```typescript
{
  name: 'search',
  params: {
    query?: string,           // Natural language search query
    format: 'index' | 'full', // Output format (default: 'index')
    type?: 'observations' | 'sessions' | 'prompts',
    obs_type?: string,        // Filter by observation type
    concepts?: string,        // Filter by concept tags
    files?: string,           // Filter by file paths
    project?: string,         // Filter by project name
    dateStart?: string | number,
    dateEnd?: string | number,
    limit?: number,           // Max results (default: 20)
    offset?: number,          // Pagination offset
    orderBy?: 'relevance' | 'date_desc' | 'date_asc'
  }
}
```

**Usage Pattern:**
1. First use `format: 'index'` for overview
2. Then use `format: 'full'` for specific items of interest

#### `timeline`
Fetch observations around a specific point in time.

```typescript
{
  name: 'timeline',
  params: {
    query?: string,           // Find anchor via semantic search
    anchor_id?: number,       // OR use specific observation ID
    before?: number,          // Observations before anchor (default: 10)
    after?: number,           // Observations after anchor (default: 10)
    format: 'index' | 'full',
    obs_type?: string,
    concepts?: string,
    files?: string,
    project?: string
  }
}
```

### Semantic Shortcuts

#### `decisions`
Find architectural, design, and implementation decisions.

```typescript
{
  name: 'decisions',
  params: {
    query: string,            // Natural language query
    format: 'index' | 'full',
    limit?: number,
    dateStart?: string | number,
    dateEnd?: string | number
  }
}
```

#### `changes`
Find code changes, refactorings, and modifications.

```typescript
{
  name: 'changes',
  params: {
    query: string,
    format: 'index' | 'full',
    limit?: number,
    dateStart?: string | number,
    dateEnd?: string | number
  }
}
```

#### `how_it_works`
Understand system architecture and implementation details.

```typescript
{
  name: 'how_it_works',
  params: {
    query: string,
    format: 'index' | 'full',
    limit?: number,
    dateStart?: string | number,
    dateEnd?: string | number
  }
}
```

### Filter Tools

#### `find_by_concept`
Find observations tagged with specific concepts.

```typescript
{
  name: 'find_by_concept',
  params: {
    concepts: string,         // Concept tag(s), comma-separated
    format: 'index' | 'full',
    type?: string,
    files?: string,
    project?: string,
    dateStart?: string | number,
    dateEnd?: string | number,
    limit?: number,
    offset?: number,
    orderBy?: 'date_desc' | 'date_asc'
  }
}
```

#### `find_by_file`
Find observations related to specific file paths.

```typescript
{
  name: 'find_by_file',
  params: {
    files: string,            // File path(s), comma-separated
    format: 'index' | 'full',
    type?: string,
    concepts?: string,
    project?: string,
    dateStart?: string | number,
    dateEnd?: string | number,
    limit?: number,
    offset?: number,
    orderBy?: 'date_desc' | 'date_asc'
  }
}
```

#### `find_by_type`
Find observations of specific types.

```typescript
{
  name: 'find_by_type',
  params: {
    type: string,             // Observation type(s), comma-separated
    format: 'index' | 'full',
    concepts?: string,
    files?: string,
    project?: string,
    dateStart?: string | number,
    dateEnd?: string | number,
    limit?: number,
    offset?: number,
    orderBy?: 'date_desc' | 'date_asc'
  }
}
```

### Context Tools

#### `get_recent_context`
Get recent session context for timeline display.

```typescript
{
  name: 'get_recent_context',
  params: {
    limit?: number,           // Max timeline items (default: 30)
    format: 'index' | 'full',
    type?: string,
    concepts?: string,
    files?: string,
    project?: string,
    dateStart?: string | number,
    dateEnd?: string | number
  }
}
```

#### `get_context_timeline`
Get timeline around a specific observation ID.

```typescript
{
  name: 'get_context_timeline',
  params: {
    anchor_id: number,        // Observation ID as anchor
    before?: number,          // Observations before (default: 10)
    after?: number,           // Observations after (default: 10)
    format: 'index' | 'full',
    type?: string,
    concepts?: string,
    files?: string,
    project?: string
  }
}
```

#### `get_timeline_by_query`
Combined search + timeline: find observation then show context.

```typescript
{
  name: 'get_timeline_by_query',
  params: {
    query: string,            // Find anchor via semantic search
    before?: number,
    after?: number,
    format: 'index' | 'full',
    type?: string,
    concepts?: string,
    files?: string,
    project?: string,
    dateStart?: string | number,
    dateEnd?: string | number
  }
}
```

### Deprecated Tools

These tools are deprecated in favor of unified `search`:

- `search_observations` → Use `search` with `type="observations"`
- `search_sessions` → Use `search` with `type="sessions"`
- `search_user_prompts` → Use `search` with `type="prompts"`

## Tool to Endpoint Mapping

```typescript
const TOOL_ENDPOINT_MAP: Record<string, string> = {
  'search': '/api/search',
  'timeline': '/api/timeline',
  'decisions': '/api/decisions',
  'changes': '/api/changes',
  'how_it_works': '/api/how-it-works',
  'search_observations': '/api/search/observations',
  'search_sessions': '/api/search/sessions',
  'search_user_prompts': '/api/search/prompts',
  'find_by_concept': '/api/search/by-concept',
  'find_by_file': '/api/search/by-file',
  'find_by_type': '/api/search/by-type',
  'get_recent_context': '/api/context/recent',
  'get_context_timeline': '/api/context/timeline',
  'get_timeline_by_query': '/api/timeline/by-query'
};
```

## Worker API Communication

All tool handlers delegate to the Worker HTTP API:

```typescript
async function callWorkerAPI(
  endpoint: string,
  params: Record<string, any>
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  try {
    const searchParams = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) {
        searchParams.append(key, String(value));
      }
    }

    const url = `${WORKER_BASE_URL}${endpoint}?${searchParams}`;
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Worker API error (${response.status}): ${await response.text()}`);
    }

    return await responseon();
  } catch (error: any) {
    return {
      content: [{ type: 'text', text: `Error calling Worker API: ${error.message}` }],
      isError: true
    };
  }
}
```

## Configuration

### Environment Variables

```bash
CLAUDE_MEM_WORKER_PORT=37777  # Worker HTTP port (default: 37777)
```

### Worker Base URL

```typescript
const WORKER_PORT = parseInt(process.env.CLAUDE_MEM_WORKER_PORT || '37777', 10);
const WORKER_BASE_URL = `http://localhost:${WORKER_PORT}`;
```

## Schema Validation

Tool input schemas use Zod for validation:

```typescript
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

const searchSchema = z.object({
  query: z.string().optional(),
  format: z.enum(['index', 'full']).default('index'),
  type: z.enum(['observations', 'sessions', 'prompts']).optional(),
  limit: z.number().min(1).max(100).default(20),
  // ... more fields
});

// Convert to JSON Schema for MCP protocol
const jsonSchema = zodToJsonSchema(searchSchema);
```

## Error Handling

```typescript
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const tool = tools.find(t => t.name === request.params.name);

  if (!tool) {
    throw new Error(`Unknown tool: ${request.params.name}`);
  }

  try {
    return await tool.handler(request.params.arguments || {});
  } catch (error: any) {
    return {
      content: [{ type: 'text', text: `Tool execution failed: ${error.message}` }],
      isError: true
    };
  }
});
```

## Startup and Shutdown

```typescript
async function main() {
  // Start MCP server
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Check Worker availability
  setTimeout(async () => {
    const available = await verifyWorkerConnection();
    if (!available) {
      silentDebug('[search-server] Worker not available');
      silentDebug('[search-server] Tools will fail until Worker is started');
    }
  }, 0);
}

// Graceful shutdown
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
```

## Building

The MCP server is built as a CommonJS module:

```javascript
// scripts/build-hooks
await Bun.build({
  entrypoints: ['src/servers/mcp-server.ts'],
  outdir: 'plugin/scripts',
  target: 'bun',
  format: 'cjs',
  minify: true,
  naming: 'mcp-server.[ext]'
});
```

**Output:** `plugin/scripts/mcp-server.cjs`

## Integration with Worker Service

The Worker Service spawns the MCP server as a child process:

```typescript
// src/services/worker-service.ts
import { Client } from '@modelcontextprotocol/sdk/client/index';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio';

// Initialize MCP client
this.mcpClient = new Client(
  { name: 'worker-search-proxy', version: '1.0.0' },
  { capabilities: {} }
);

// Connect to MCP server
const mcpServerPath = path.join(__dirname, '..', '..', 'plugin', 'scripts', 'mcp-server.cjs');
const transport = new StdioClientTransport({
  command: 'node',
  args: [mcpServerPath],
  env: process.env
});

await this.mcpClient.connect(transport);
```

## Testing Tools

You can test MCP tools directly via the Worker HTTP API:

```bash
# Search observations
curl "http://localhost:37777/api/search?query=authentication&type=observations&format=index"

# Get timeline around observation
curl "http://localhost:37777/api/timeline?anchor_id=123&before=10&after=10"

# Find decisions
curl "http://localhost:37777/api/decisions?query=database%20schema&format=index"

# Find by file
curl "http://localhost:37777/api/search/by-file?files=auth.ts&format=index"
```
