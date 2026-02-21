# Plan: PreToolUse hook for rule-breaking pattern detection

## Context

Claude Code rules (in `.claude/rules/` and `~/.claude/rules/`) define coding standards — functional style, Result pattern over try/catch, no classes, no silent fallbacks, git restrictions, etc. Currently nothing enforces these at write-time. This adds a **PreToolUse command hook** that scans Write/Edit tool inputs for rule-breaking patterns and blocks the tool call with a reason before it lands.

The hook reads rule files from disk on each invocation, extracts regex patterns, and checks the `new_string` (Edit) or `content` (Write) against them. When a pattern matches, it returns `permissionDecision: "deny"` with the violated rule as the reason.

## Design

### How PreToolUse hooks work
- Fires before Write/Edit execute
- Reads JSON from stdin with `tool_name`, `tool_input` (containing `file_path`, `content`/`new_string`/`old_string`)
- Returns JSON with `hookSpecificOutput.permissionDecision: "deny"|"allow"` and `permissionDecisionReason`
- Exit 0 with no output = silent allow

### Rule-to-pattern mapping

Each rule file maps to one or more regex patterns applied to the content being written. Not every rule is enforceable via regex — workflow/communication rules are skipped.

| Rule file | Pattern(s) | Reason |
|-----------|-----------|--------|
| `coding/functional-style.md` | `\bclass\s+\w+`, `\bextends\s+\w+`, `\bnew\s+[A-Z]\w+\(` | No classes/inheritance |
| `coding/error-handling.md` | `\btry\s*\{`, `\bcatch\s*\(` | Use Result pattern, not try/catch |
| `coding/no-silent-fallbacks.md` (global) | `catch\s*\([^)]*\)\s*\{\s*\}`, `catch\s*\([^)]*\)\s*\{\s*\/\/` | No empty/silent catch blocks |
| `safety/git-restrictions.md` (global) | N/A — only applies to Bash, not Write/Edit |

Additional patterns (always active, derived from project CLAUDE.md):
| Pattern | Reason |
|---------|--------|
| `\bprocess\.exit\b` in test files | Tests should not call process.exit |

### Architecture

**Single bun script** at `src/hooks/pretool-guard.ts`:
1. Read stdin JSON, extract `tool_name` and `tool_input`
2. If `tool_name` is not `Write` or `Edit`, exit 0 (allow)
3. Extract the content to check: `tool_input.content` (Write) or `tool_input.new_string` (Edit)
4. Load rule files from `$CLAUDE_PROJECT_DIR/.claude/rules/` + `~/.claude/rules/`
5. Map rule files to regex patterns via a hardcoded mapping (rule filename → patterns)
6. Check content against all patterns
7. On first match: output deny JSON with the rule name + matched pattern as reason
8. No match: exit 0 (silent allow)

**Why hardcoded mapping**: Rule files are prose markdown — extracting patterns dynamically would require NLP. Instead, we maintain a mapping from rule file paths (by basename) to regex patterns. When a new rule is added, a corresponding pattern entry is added to the mapping. This is explicit and auditable.

**Caching**: Since each hook invocation is a separate process, there's no persistent memory. Instead, rule files are read once per invocation (fast — they're small markdown files on local disk, ~12 files totaling <5KB). We glob for rule files and check which ones exist before applying patterns. This means adding/removing rule files takes effect immediately with no cache invalidation needed.

## Files to create

### `src/hooks/pretool-guard.ts`
The PreToolUse hook script. Pure function architecture:

- `RulePattern` type: `{ readonly ruleFile: string; readonly patterns: readonly RegExp[]; readonly reason: string }`
- `RULE_PATTERN_MAP` constant: maps rule file basenames to patterns
- `loadActiveRules(dirs: readonly string[]): readonly RulePattern[]` — globs for rule files, returns only patterns whose rule file exists on disk
- `checkContent(content: string, rules: readonly RulePattern[]): { readonly violated: boolean; readonly rule?: string; readonly reason?: string; readonly match?: string }`
- `main()` — reads stdin, dispatches to checkContent, writes stdout

### `src/types/hooks.ts`
Add `PreToolUseInput` interface matching the Claude Code contract.

### `tests/unit/pretool-guard.test.ts`
Unit tests for `checkContent` and `loadActiveRules`:
- Detects class declarations
- Detects try/catch
- Detects empty catch blocks
- Allows clean functional code
- Only activates rules whose files exist on disk
- Handles Write vs Edit input correctly

## Files to modify

### `hooks/hooks.json`
Add `PreToolUse` entry with matcher `Write|Edit`:

```json
"PreToolUse": [
  {
    "matcher": "Write|Edit",
    "hooks": [
      {
        "type": "command",
        "command": "${CLAUDE_PLUGIN_ROOT}/bin/goldfish hook:guard",
        "timeout": 5,
        "statusMessage": "Checking rules..."
      }
    ]
  }
]
```

### `src/cli.ts`
Add `hook:guard` command entry pointing to `src/hooks/pretool-guard.ts`.

## Implementation order

1. Add `PreToolUseInput` to `src/types/hooks.ts`
2. Create `src/hooks/pretool-guard.ts` with rule pattern mapping + check logic
3. Create `tests/unit/pretool-guard.test.ts`
4. Register `hook:guard` in `src/cli.ts`
5. Add `PreToolUse` to `hooks/hooks.json`
6. `bun test` + `bunx biome check --write .`

## Verification

1. `bun test` — all tests pass (including new pretool-guard tests)
2. Manual test: `echo '{"tool_name":"Write","tool_input":{"file_path":"test.ts","content":"class Foo {}"}}' | bun src/hooks/pretool-guard.ts` — should output deny JSON
3. Manual test: `echo '{"tool_name":"Write","tool_input":{"file_path":"test.ts","content":"const foo = 42;"}}' | bun src/hooks/pretool-guard.ts` — should output nothing (allow)
4. Manual test: `echo '{"tool_name":"Read","tool_input":{"file_path":"test.ts"}}' | bun src/hooks/pretool-guard.ts` — should output nothing (not Write/Edit)
