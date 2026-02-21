---
description: Show recent architectural and design decisions
category: memory
allowed-tools: Bash(goldfish:*)
---

# Recent Decisions

Show architectural and design decisions recorded for this project.

!goldfish decisions --limit 20

## Output Rules

1. If the command fails with a connection error, suggest starting the worker with `goldfish worker`.
2. Otherwise, display each decision with:
   - Title and narrative
   - Files involved (if any)
   - When the decision was made (relative time)
3. If count is 0, tell the user no decisions have been recorded for this project yet.
