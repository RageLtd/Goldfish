---
description: Check how many observations still need embeddings computed
category: memory
allowed-tools: Bash(curl:*)
---

# Backfill Status

Check the current embedding backfill progress.

!PORT="${GOLDFISH_PORT:-3456}"; curl -sS "http://127.0.0.1:${PORT}/backfill/status"

## Output Rules

1. If the response contains an `error` field, show the error and suggest starting the worker with `goldfish worker`.
2. Otherwise, report:
   - **remaining**: how many observations still lack embeddings
   - **pendingMessages**: how many embed messages are queued in the worker
3. If both are 0, confirm all observations have embeddings.
