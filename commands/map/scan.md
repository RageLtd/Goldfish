---
description: Scan the current project and build a codebase map with LLM-generated directory summaries
category: map
allowed-tools: Bash(goldfish:*)
---

# Map Scan

Scan the project directory and build a codebase map. This walks all git-tracked files, groups them by directory, and generates LLM summaries for each directory.

!goldfish map:scan

## Output Rules

1. If the command fails with a connection error, tell the user the worker is not running and suggest `goldfish worker`.
2. This is a long-running operation. Report progress as it completes.
3. Show the final summary: total files scanned, directories summarized, errors.
4. Suggest running `goldfish map:show` to view the result.
