---
description: Search the codebase map for directories or files matching a query
category: map
allowed-tools: Bash(goldfish:*)
argument-hint: '<query> - e.g., "authentication", "database handlers", "test utilities"'
---

# Map Search

Search the codebase map using full-text search on paths and summaries.

!goldfish map:search $ARGUMENTS

## Output Rules

1. If the command fails with a connection error, suggest starting the worker with `goldfish worker`.
2. If no results, suggest broadening the search terms or running `/map:scan` if the map hasn't been built.
3. Display results as `path — summary`.
