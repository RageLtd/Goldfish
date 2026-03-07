---
description: Show file-level detail for a specific directory in the codebase map
category: map
allowed-tools: Bash(goldfish:*)
argument-hint: '<directory> - e.g., "src/worker", "src/hooks", "tests/unit"'
---

# Map Detail

Show file-level entries for a specific directory in the codebase map.

!goldfish map:detail $ARGUMENTS

## Output Rules

1. If the command fails with a connection error, suggest starting the worker with `goldfish worker`.
2. If no results, suggest running `/map:scan` first or checking the directory path.
3. Display the output as-is — it's already formatted.
