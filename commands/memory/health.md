---
description: Check worker status, uptime, queue depth, and last prune stats
category: memory
allowed-tools: Bash(goldfish:*)
---

# Worker Health

Check the goldfish worker's health status.

!goldfish health

## Output Rules

1. If the command fails with a connection error, tell the user the worker is not running and suggest `goldfish worker`.
2. Otherwise, report:
   - **status**: ok/error
   - **version**: worker version
   - **uptimeSeconds**: how long the worker has been running
   - **pendingMessages**: messages queued for processing
   - **lastPrune**: if present, show when the last auto-prune ran and what it removed (aged, duplicates, low-score, total deleted)
