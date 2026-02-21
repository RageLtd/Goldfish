---
description: Show a chronological timeline of recent observations and summaries
category: memory
allowed-tools: Bash(goldfish:*)
---

# Memory Timeline

Show a chronological view of recent observations and session summaries.

!goldfish timeline --limit 20

## Output Rules

1. If the command fails with a connection error, suggest starting the worker with `goldfish worker`.
2. Otherwise, display the timeline as a list sorted by most recent first:
   - For each item show: relative time, kind (observation/summary), type, and title
   - Include the narrative or completed text if available
3. If count is 0, tell the user no recent activity was found for this project.
