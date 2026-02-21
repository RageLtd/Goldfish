---
description: Enqueue embedding computation for observations missing embeddings
category: memory
allowed-tools: Bash(curl:*)
---

# Backfill Embeddings

Trigger the worker to enqueue embedding computation for all observations that lack embeddings.

!PORT="${GOLDFISH_PORT:-3456}"; curl -sS -X POST "http://127.0.0.1:${PORT}/backfill"

## Output Rules

1. If the response contains an `error` field, show the error and suggest starting the worker with `goldfish worker`.
2. Otherwise, report how many observations were enqueued for embedding computation.
3. Note that embedding computation happens in the background — the worker will process them over time.
