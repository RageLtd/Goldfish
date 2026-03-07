---
description: Show codebase map statistics (directories, files, coverage)
category: map
allowed-tools: Bash(goldfish:*)
---

# Map Stats

Show statistics about the codebase map for the current project.

!goldfish map:stats

## Output Rules

1. If the command fails with a connection error, suggest starting the worker with `goldfish worker`.
2. Report:
   - **directories**: number of directories indexed
   - **files**: number of files indexed
   - **withSummary**: number of entries with LLM-generated summaries
3. If all counts are 0, suggest running `/map:scan` to build the map.
