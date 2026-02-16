---
description: Show the same context that claude-mem injects at session start
category: memory
allowed-tools: Bash(curl:*), Bash(basename:*), Bash(pwd:*)
---

# Show Previously Injected Context

Fetch and display the same indexed context payload that `hook:context` injects for the current project.

!PROJECT=$(basename "$(pwd)"); PORT="${CLAUDE_MEM_PORT:-3456}"; curl -sS "http://127.0.0.1:${PORT}/context?project=${PROJECT}&limit=50&format=index"

## Output Rules

1. If the response contains an `error` field, show the error and suggest starting the worker with `claude-mem worker`.
2. Otherwise, show:
   - Project name
   - Observation and summary counts
   - The `context` body exactly as returned
