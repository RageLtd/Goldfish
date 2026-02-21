---
description: Find and delete low-value observations from the goldfish memory database
---

Run the goldfish prune command to identify low-value observations. Use dry-run first to review candidates, then execute with `--execute` to delete.

```bash
# Dry-run: show candidates without deleting
bun src/cli.ts prune

# Filter to a specific project
bun src/cli.ts prune --project <project-name>

# Actually delete after reviewing dry-run output
bun src/cli.ts prune --execute
```

Show the user the output and summarize what was found or deleted.
