# Hook System Documentation

**Purpose:** Capture Claude Code lifecycle events and communicate with the worker service.

## Design Philosophy

Hooks are **thin HTTP clients** that:
1. Run in the Claude Code process (not background)
2. Have no native module dependencies (works on Node or Bun)
3. Use fire-and-forget pattern (don't block Claude Code)
4. Delegate all database operations to the worker service

## Hook Configuration

**File:** `plugin/hooks/hooks.json`

```json
{
  "hooks": {
    "SessionStart": [
      { "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/bin/claude-mem hook:context" }
    ],
    "UserPromptSubmit": [
      { "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/bin/claude-mem hook:new" }
    ],
    "PostToolUse": [
      {
        "matcher": "*",
        "hooks": [
          { "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/bin/claude-mem hook:save" }
        ]
      }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/bin/claude-mem hook:summary" }] }
    ],
    "SessionEnd": [
      { "hooks": [{ "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/bin/claude-mem hook:cleanup" }] }
    ]
  }
}
```

> **Note:** All hooks use a single unified CLI binary (`claude-mem`) with subcommands. This reduces plugin size from ~400MB to ~58MB. Run `bun run build` to rebuild.

## Hook Lifecycle

```
Claude Code Session
│
├─► SessionStart (startup|clear|compact)
│   ├─► context-hook → Inject past observations as context
│   └─► user-message-hook → Track user message metadata
│
├─► UserPromptSubmit (each user message)
│   └─► new-hook → Create/update session, save user prompt
│
├─► PostToolUse (after each tool execution)
│   └─► save-hook → Capture tool observation
│
├─► Stop (user clicks stop or session pauses)
│   └─► summary-hook → Generate session summary
│
└─► SessionEnd (session terminates)
    └─► cleanup-hook → Mark session complete
```

## Individual Hook Details

### 1. context-hook (SessionStart)

**Purpose:** Inject relevant past observations into new sessions.

**Trigger:** SessionStart with matcher `startup|clear|compact`

**Input:**
```typescript
interface SessionStartInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  source?: "startup" | "resume" | "clear" | "compact";
}
```

**Output:**
```json
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "# [claude-mem] recent context\n\n..."
  }
}
```

**Flow:**
1. Wait for worker health check (up to 10s)
2. GET `/api/context/inject?project={project}`
3. Return formatted context as `additionalContext`

**Key Code:**
```typescript
const url = `http://127.0.0.1:${port}/api/context/inject?project=${encodeURIComponent(project)}`;
const result = execSync(`curl -s "${url}"`, { encoding: "utf-8", timeout: 5000 });
```

### 2. new-hook (UserPromptSubmit)

**Purpose:** Initialize or continue session, save user prompt.

**Trigger:** Every UserPromptSubmit event

**Input:**
```typescript
interface UserPromptSubmitInput {
  session_id: string;  // Claude Code session ID (source of truth)
  cwd: string;         // Working directory
  prompt: string;      // User's message
}
```

**Critical Architecture:**
- Uses `session_id` from Claude Code as THE source of truth
- `createSDKSession()` is idempotent (INSERT OR IGNORE)
- Prompt #1 creates new session, prompt #2+ reuses existing
- ALL hooks use same session_id to stay connected

**Flow:**
1. Ensure worker is running
2. Create/get session: `db.createSDKSession(session_id, project, prompt)`
3. Increment prompt counter: `db.incrementPromptCounter(sessionDbId)`
4. Strip privacy tags from prompt
5. Skip if prompt is entirely private
6. Save cleaned prompt: `db.saveUserPrompt(session_id, promptNumber, cleanedUserPrompt)`
7. POST `/sessions/{sessionDbId}/init` to worker

**Privacy Handling:**
```typescript
const cleanedUserPrompt = stripMemoryTagsFromPrompt(prompt);
if (!cleanedUserPrompt || cleanedUserPrompt.trim() === '') {
  // Skip memory operations for fully private prompts
  return;
}
```

### 3. save-hook (PostToolUse)

**Purpose:** Capture tool executions as observations.

**Trigger:** After every tool use (matcher: `*`)

**Input:**
```typescript
interface PostToolUseInput {
  session_id: string;
  cwd: string;
  tool_name: string;
  tool_input: any;
  tool_response: any;
}
```

**Skip List:**
```typescript
const SKIP_TOOLS = new Set([
  'SlashCommand',          // Command invocation meta-tool
  'Skill',                 // Skill invocation meta-tool
  'TodoWrite',             // Task management meta-tool
  'AskUserQuestion'        // User interaction, not substantive work
]);
```

**Flow:**
1. Check if tool is in SKIP_TOOLS, return early if so
2. Ensure worker is running
3. POST `/api/sessions/observations` with:
   - `claudeSessionId`
   - `tool_name`
   - `tool_input`
   - `tool_response`
   - `cwd`

**Key Code:**
```typescript
const response = await fetch(`http://127.0.0.1:${port}/api/sessions/observations`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    claudeSessionId: session_id,
    tool_name,
    tool_input,
    tool_response,
    cwd: cwd || ''
  }),
  signal: AbortSignal.timeout(2000)
});
```

### 4. summary-hook (Stop)

**Purpose:** Generate end-of-session summary.

**Trigger:** When user clicks Stop or session pauses

**Input:**
```typescript
interface StopInput {
  session_id: string;
  cwd: string;
  transcript_path?: string;
}
```

**Flow:**
1. Ensure worker is running
2. Extract last user message from transcript (JSONL format)
3. Extract last assistant message from transcript
4. Strip `<system-reminder>` tags from assistant message
5. POST `/api/sessions/summarize` with:
   - `claudeSessionId`
   - `last_user_message`
   - `last_assistant_message`
6. POST `/api/processing` to stop spinner

**Transcript Parsing:**
```typescript
// Claude Code transcript format: JSONL
// {type: "user", message: {role: "user", content: [...]}}
// {type: "assistant", message: {role: "assistant", content: [...]}}

function extractLastUserMessage(transcriptPath: string): string {
  const lines = content.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = JSON.parse(lines[i]);
    if (line.type === 'user' && line.message?.content) {
      // Extract text content
    }
  }
}
```

### 5. cleanup-hook (SessionEnd)

**Purpose:** Mark session complete and cleanup resources.

**Trigger:** When session terminates

**Input:**
```typescript
interface SessionEndInput {
  session_id: string;
  cwd: string;
  transcript_path?: string;
  hook_event_name: string;
  reason: 'exit' | 'clear' | 'logout' | 'prompt_input_exit' | 'other';
}
```

**Flow:**
1. POST `/api/sessions/complete` with `claudeSessionId` and `reason`
2. Non-blocking - session might not exist and that's okay
3. Output `{"continue": true, "suppressOutput": true}`

**Error Handling:**
```typescript
try {
  const response = await fetch(`http://127.0.0.1:${port}/api/sessions/complete`, ...);
  // Handle response
} catch (error: any) {
  // Worker might not be running - that's okay
  silentDebug('[cleanup-hook] Worker not reachable (non-critical)', { error: error.message });
}
```

## Hook Response Format

All hooks return JSON to Claude Code:

```typescript
function createHookResponse(hookName: string, success: boolean): string {
  return JSON.stringify({
    continue: true,
    suppressOutput: success,
    hookSpecificOutput: success ? undefined : { error: `${hookName} failed` }
  });
}
```

**Special case - context-hook:**
```json
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "# Context injected by claude-mem..."
  }
}
```

## Worker Communication

### Worker Auto-Start

Hooks automatically start the worker if not running:

```typescript
// In hooks/runner.ts
const ensureWorker = async (): Promise<void> => {
  if (await isWorkerHealthy()) return;

  // Spawn worker as background process
  const child = spawn(workerBin, ["worker"], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  // Wait for worker to become healthy
  await waitForHealthy();
};
```

### Error Handling Pattern

All hooks fail gracefully - they always return valid output so Claude Code continues:

```typescript
try {
  const input = await readStdin<T>();
  await ensureWorker();
  const output = await processor(deps, input);
  writeStdout(output);
} catch {
  // Always return valid output so Claude Code continues
  writeStdout({ continue: true, suppressOutput: true });
}
```

## Privacy Tag Stripping

**File:** `src/utils/tag-stripping.ts`

Two functions for different contexts:

1. **stripMemoryTagsFromPrompt** - For user prompts
   - Strips `<private>` and `<claude-mem-context>` tags
   - Returns empty string if entire prompt is private

2. **stripMemoryTagsFromJson** - For JSON contexts
   - Same tag stripping
   - Returns `'{}'` for non-string inputs (defensive)

**Pattern:**
```typescript
function stripMemoryTags(content: string): string {
  return content
    .replace(/<claude-mem-context>[\s\S]*?<\/claude-mem-context>/g, '')
    .replace(/<private>[\s\S]*?<\/private>/g, '')
    .trim();
}
```

## Building the CLI

All components are compiled into a single unified CLI binary:

```bash
# Build command
bun run build

# Output: bin/claude-mem (single ~58MB binary)
```

The CLI provides subcommands for all functionality:

```bash
claude-mem hook:context    # SessionStart hook
claude-mem hook:new        # UserPromptSubmit hook
claude-mem hook:save       # PostToolUse hook
claude-mem hook:summary    # Stop hook
claude-mem hook:cleanup    # SessionEnd hook
claude-mem worker          # Start HTTP worker service
claude-mem version         # Show version
```

This unified approach reduces plugin size from ~400MB (7 separate binaries) to ~58MB (1 binary with subcommands).

## Testing Hooks

Hooks can be tested by simulating stdin input:

```typescript
// tests/happy-paths/observation-capture.test.ts
it('captures Bash command observation', async () => {
  global.fetch = mock(() => Promise.resolve({
    ok: true,
    status: 200,
    json: async () => ({ status: 'queued' })
  }));

  const response = await fetch(
    `http://127.0.0.1:${WORKER_PORT}/api/sessions/observations`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        claudeSessionId: 'test-session',
        tool_name: 'Bash',
        tool_input: { command: 'git status' },
        tool_response: { stdout: 'On branch main...' },
        cwd: '/project'
      })
    }
  );

  expect(response.ok).toBe(true);
});
```

## Debugging Hooks

### Silent Debug Logging

Hooks use `silentDebug()` to log without disrupting Claude Code:

```typescript
import { silentDebug } from '../utils/silent-debug';

silentDebug('[hook-name] Message', { data });
// Writes to ~/.claude-mem/silent.log
```

### Console Error for User Messages

Use `console.error()` for messages visible in terminal:

```typescript
console.error(`[new-hook] Session ${sessionDbId}, prompt #${promptNumber}`);
```

### Log Levels

```typescript
import { logger } from '../utils/logger';

logger.debug('HOOK', 'Debug message', { data });
logger.dataIn('HOOK', 'PostToolUse: Bash(git status)', { workerPort: 37777 });
logger.failure('HOOK', 'Failed to send', { status: 500 }, errorText);
logger.error('HOOK', 'Error', {}, error);
```
