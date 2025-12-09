# SDK Agent Documentation

**Purpose:** Process tool observations using Claude AI to extract semantic meaning, generate structured observations, and create session summaries.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           SDKAgent                                       │
│                                                                          │
│  ┌─────────────────┐     ┌──────────────────┐     ┌──────────────────┐ │
│  │ Message         │────►│ Agent SDK Query  │────►│ Response Parser  │ │
│  │ Generator       │     │ Loop             │     │ (XML → Objects)  │ │
│  └─────────────────┘     └──────────────────┘     └──────────────────┘ │
│         ▲                                                   │          │
│         │                                                   ▼          │
│  ┌──────┴──────────┐                              ┌──────────────────┐ │
│  │ SessionManager  │                              │ SessionStore +   │ │
│  │ (message queue) │                              │ ChromaSync       │ │
│  └─────────────────┘                              └──────────────────┘ │
└─────────────────────────────────────────────────────────────────────────┘
```

## Core Components

### SDKAgent Class

**File:** `src/services/worker/SDKAgent.ts`

The SDK agent spawns a Claude subprocess via the Anthropic Agent SDK and feeds it observation prompts.

```typescript
class SDKAgent {
  constructor(dbManager: DatabaseManager, sessionManager: SessionManager)

  // Start agent for a session (event-driven)
  async startSession(session: ActiveSession, worker?: any): Promise<void>

  // Create message generator (yields prompts from queue)
  private async *createMessageGenerator(session: ActiveSession): AsyncIterableIterator<SDKUserMessage>

  // Process SDK response (parse XML, save to database)
  private async processSDKResponse(session: ActiveSession, text: string, worker: any, discoveryTokens: number): Promise<void>
}
```

### Agent SDK Integration

The SDK agent uses `@anthropic-ai/claude-agent-sdk` to spawn a Claude subprocess:

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';

const queryResult = query({
  prompt: messageGenerator,
  options: {
    model: 'claude-haiku-4-5',  // From settings
    disallowedTools: [          // Memory agent is OBSERVER ONLY
      'Bash', 'Read', 'Write', 'Edit', 'Grep', 'Glob',
      'WebFetch', 'WebSearch', 'Task', 'NotebookEdit',
      'AskUserQuestion', 'TodoWrite'
    ],
    abortController: session.abortController,
    pathToClaudeCodeExecutable: claudePath
  }
});

// Process SDK responses
for await (const message of queryResult) {
  if (message.type === 'assistant') {
    await this.processSDKResponse(session, textContent, worker, discoveryTokens);
  }
}
```

## Prompt Engineering

### 1. Initial Prompt (buildInitPrompt)

**When:** First user prompt in session (promptNumber === 1)

**Purpose:** Set up the memory agent's context and instructions.

```typescript
function buildInitPrompt(project: string, sessionId: string, userPrompt: string): string
```

**Key Instructions:**
- Agent is an OBSERVER, not an executor
- Record what was LEARNED/BUILT/FIXED/DEPLOYED/CONFIGURED
- Focus on deliverables and capabilities
- Use verbs: implemented, fixed, deployed, configured, migrated, optimized
- Skip routine operations (empty checks, package installs, file listings)

**Good Observations:**
- "Authentication now supports OAuth2 with PKCE flow"
- "Deployment pipeline runs canary releases with auto-rollback"

**Bad Observations (DO NOT DO):**
- "Analyzed authentication implementation and stored findings"
- "Tracked deployment steps and logged outcomes"

### 2. Observation Prompt (buildObservationPrompt)

**When:** Each PostToolUse event

**Purpose:** Feed tool execution data to the memory agent.

```typescript
function buildObservationPrompt(obs: Observation): string
```

**Input Format:**
```xml
<observed_from_primary_session>
  <what_happened>Bash</what_happened>
  <occurred_at>2025-01-15T10:30:00.000Z</occurred_at>
  <working_directory>/Users/dev/myproject</working_directory>
  <parameters>{"command": "git status"}</parameters>
  <outcome>{"stdout": "On branch main..."}</outcome>
</observed_from_primary_session>
```

### 3. Summary Prompt (buildSummaryPrompt)

**When:** Stop event (user clicks stop or session pauses)

**Purpose:** Generate end-of-session progress summary.

```typescript
function buildSummaryPrompt(session: SDKSession): string
```

**Summary Fields:**
- `request` - What user asked for
- `investigated` - What was explored
- `learned` - What was discovered
- `completed` - What was done
- `next_steps` - Current trajectory of work
- `notes` - Additional insights

### 4. Continuation Prompt (buildContinuationPrompt)

**When:** Additional prompts in same session (promptNumber > 1)

**Purpose:** Continue observing with refreshed context.

```typescript
function buildContinuationPrompt(userPrompt: string, promptNumber: number, claudeSessionId: string): string
```

**Key:** Uses the same `claudeSessionId` from hooks to maintain session threading.

## XML Output Formats

### Observation XML

```xml
<observation>
  <type>[ bugfix | feature | refactor | change | discovery | decision ]</type>
  <title>Short title capturing the core action or topic</title>
  <subtitle>One sentence explanation (max 24 words)</subtitle>
  <facts>
    <fact>Concise, self-contained statement</fact>
    <fact>Another fact with specific details</fact>
  </facts>
  <narrative>Full context: What was done, how it works, why it matters</narrative>
  <concepts>
    <concept>how-it-works</concept>
    <concept>problem-solution</concept>
  </concepts>
  <files_read>
    <file>path/to/file.ts</file>
  </files_read>
  <files_modified>
    <file>path/to/modified.ts</file>
  </files_modified>
</observation>
```

**Observation Types:**
| Type | Description |
|------|-------------|
| `bugfix` | Something was broken, now fixed |
| `feature` | New capability or functionality added |
| `refactor` | Code restructured, behavior unchanged |
| `change` | Generic modification (docs, config, misc) |
| `discovery` | Learning about existing system |
| `decision` | Architectural/design choice with rationale |

**Concept Tags:**
| Concept | Description |
|---------|-------------|
| `how-it-works` | Understanding mechanisms |
| `why-it-exists` | Purpose or rationale |
| `what-changed` | Modifications made |
| `problem-solution` | Issues and their fixes |
| `gotcha` | Traps or edge cases |
| `pattern` | Reusable approach |
| `trade-off` | Pros/cons of a decision |

### Summary XML

```xml
<summary>
  <request>Short title: user's request AND substance of what was done</request>
  <investigated>What has been explored? What was examined?</investigated>
  <learned>What have you learned about how things work?</learned>
  <completed>What work has been completed? What has shipped?</completed>
  <next_steps>What are you actively working on next?</next_steps>
  <notes>Additional insights or observations</notes>
</summary>
```

## XML Parsing

**File:** `src/sdk/parser.ts`

### ParsedObservation Interface

```typescript
interface ParsedObservation {
  type: string;               // Validated: bugfix|feature|refactor|change|discovery|decision
  title: string | null;
  subtitle: string | null;
  facts: string[];
  narrative: string | null;
  concepts: string[];         // Type filtered out (separate dimensions)
  files_read: string[];
  files_modified: string[];
}
```

### ParsedSummary Interface

```typescript
interface ParsedSummary {
  request: string | null;
  investigated: string | null;
  learned: string | null;
  completed: string | null;
  next_steps: string | null;
  notes: string | null;
}
```

### Parsing Rules

**CRITICAL:** Always save observations and summaries, even with missing fields.

1. **Type Validation:**
   - If type is missing or invalid, default to `'change'`
   - Valid types: `bugfix`, `feature`, `refactor`, `change`, `discovery`, `decision`

2. **Concept Filtering:**
   - Filter out observation type from concepts array
   - Types and concepts are separate dimensions

3. **Null Handling:**
   - All fields except type can be null
   - Empty/whitespace fields are converted to null

```typescript
function parseObservations(text: string, correlationId?: string): ParsedObservation[] {
  // Match <observation>...</observation> blocks
  const observationRegex = /<observation>([\s\S]*?)<\/observation>/g;

  // For each match:
  // 1. Extract all fields
  // 2. Validate type (default to 'change')
  // 3. Filter type from concepts
  // 4. Return ParsedObservation
}
```

## Token Tracking

The SDK agent tracks token usage for ROI metrics:

```typescript
// Before processing response
const tokensBeforeResponse = session.cumulativeInputTokens + session.cumulativeOutputTokens;

// Extract token usage from SDK response
if (usage) {
  session.cumulativeInputTokens += usage.input_tokens || 0;
  session.cumulativeOutputTokens += usage.output_tokens || 0;

  // Cache creation counts as discovery
  if (usage.cache_creation_input_tokens) {
    session.cumulativeInputTokens += usage.cache_creation_input_tokens;
  }
}

// Calculate discovery tokens (delta for this response only)
const discoveryTokens = (session.cumulativeInputTokens + session.cumulativeOutputTokens) - tokensBeforeResponse;

// Pass to processSDKResponse for storage
await this.processSDKResponse(session, textContent, worker, discoveryTokens);
```

**Storage:**
- `discovery_tokens` column in `observations` table
- `discovery_tokens` column in `session_summaries` table

## Event-Driven Message Flow

```
SessionManager.queueObservation()
       │
       ▼
 EventEmitter.emit('message')
       │
       ▼
 SDKAgent.getMessageIterator() yields
       │
       ▼
 createMessageGenerator() yields SDKUserMessage
       │
       ▼
 Agent SDK query() processes
       │
       ▼
 processSDKResponse() parses and stores
```

### Message Generator Pattern

```typescript
async *createMessageGenerator(session: ActiveSession): AsyncIterableIterator<SDKUserMessage> {
  // Yield initial prompt (init or continuation)
  yield {
    type: 'user',
    message: {
      role: 'user',
      content: session.lastPromptNumber === 1
        ? buildInitPrompt(session.project, session.claudeSessionId, session.userPrompt)
        : buildContinuationPrompt(session.userPrompt, session.lastPromptNumber, session.claudeSessionId)
    },
    session_id: session.claudeSessionId,
    isSynthetic: true
  };

  // Consume pending messages from SessionManager
  for await (const message of this.sessionManager.getMessageIterator(session.sessionDbId)) {
    if (message.type === 'observation') {
      yield {
        type: 'user',
        message: { role: 'user', content: buildObservationPrompt(message) },
        session_id: session.claudeSessionId,
        isSynthetic: true
      };
    } else if (message.type === 'summarize') {
      yield {
        type: 'user',
        message: { role: 'user', content: buildSummaryPrompt(session) },
        session_id: session.claudeSessionId,
        isSynthetic: true
      };
    }
  }
}
```

## Configuration

### Model Selection

```typescript
// From settingson or environment
const modelId = settings.CLAUDE_MEM_MODEL || 'claude-haiku-4-5';
```

### Claude Executable

```typescript
const claudePath = process.env.CLAUDE_CODE_PATH ||
  execSync('which claude', { encoding: 'utf8' }).trim();
```

## Error Handling

```typescript
try {
  // Run SDK query loop
  for await (const message of queryResult) {
    // Process messages
  }

  // Mark session complete on success
  this.dbManager.getSessionStore().markSessionCompleted(session.sessionDbId);

} catch (error: any) {
  if (error.name === 'AbortError') {
    logger.warn('SDK', 'Agent aborted', { sessionId });
  } else {
    logger.failure('SDK', 'Agent error', { sessionDbId }, error);
  }
  throw error;

} finally {
  // Always cleanup session
  this.sessionManager.deleteSession(session.sessionDbId).catch(() => {});
}
```

## ChromaSync Integration

After parsing, observations and summaries are synced to Chroma vector DB:

```typescript
// Sync observation to Chroma
this.dbManager.getChromaSync().syncObservation(
  obsId,
  session.claudeSessionId,
  session.project,
  obs,
  session.lastPromptNumber,
  createdAtEpoch,
  discoveryTokens
);

// Sync summary to Chroma
this.dbManager.getChromaSync().syncSummary(
  summaryId,
  session.claudeSessionId,
  session.project,
  summary,
  session.lastPromptNumber,
  createdAtEpoch,
  discoveryTokens
);
```

## SSE Broadcast

Real-time updates to web UI:

```typescript
// Broadcast new observation
worker.sseBroadcaster.broadcast({
  type: 'new_observation',
  observation: {
    id: obsId,
    sdk_session_id: session.sdkSessionId,
    session_id: session.claudeSessionId,
    type: obs.type,
    title: obs.title,
    // ... all fields
  }
});

// Broadcast new summary
worker.sseBroadcaster.broadcast({
  type: 'new_summary',
  summary: {
    id: summaryId,
    session_id: session.claudeSessionId,
    // ... all fields
  }
});
```
