---
description: Show the directory-level codebase map for the current project
category: map
allowed-tools: Bash(goldfish:*)
---

# Map Show

Display the directory-level codebase map with LLM-generated summaries.

!goldfish map:show

## Output Rules

1. If the command fails with a connection error, suggest starting the worker with `goldfish worker`.
2. If no map exists, suggest running `/map:scan` to build one.
3. Display the output as-is — it's already formatted as `directory/ — summary`.
