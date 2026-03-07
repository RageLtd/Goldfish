---
name: map-scan
description: Scan the current project and build a codebase map with directory summaries. Use when the user asks to "map the codebase", "index the project", "build a code map", or when starting work on a new or unfamiliar project.
---

# Codebase Map Scan

Build a codebase map by scanning all git-tracked files and generating LLM summaries for each directory.

## When to Use

- User asks to map or index the codebase
- Starting work on a new project
- Project structure has changed significantly (major refactor, new directories)

## CLI Command

```bash
~/.goldfish/bin/goldfish map:scan [--project <name>]
```

## After Scanning

Run `~/.goldfish/bin/goldfish map:show` to display the resulting directory map.

## Notes

- This is a long-running operation (one LLM call per directory)
- Only processes git-tracked files (respects .gitignore)
- Skips binary files and lock files
- Subsequent scans are incremental — unchanged files are skipped
