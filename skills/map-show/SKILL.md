---
name: map-show
description: Show the directory-level codebase map. Use when you need to understand project structure, find where code lives, or navigate an unfamiliar codebase. Prefer this over grepping to find files.
---

# Codebase Map Show

Display the directory-level codebase map with LLM-generated summaries.

## When to Use

- You need to understand the project structure
- Looking for where specific functionality lives
- Navigating an unfamiliar codebase
- Before grepping — check the map first to narrow your search

## CLI Commands

### Show directory map
```bash
~/.goldfish/bin/goldfish map:show [--project <name>]
```

### Show files in a specific directory
```bash
~/.goldfish/bin/goldfish map:detail <directory> [--project <name>]
```

Examples:
```bash
~/.goldfish/bin/goldfish map:show
~/.goldfish/bin/goldfish map:detail src/worker
~/.goldfish/bin/goldfish map:detail tests/unit
```

### Search the map
```bash
~/.goldfish/bin/goldfish map:search <query> [--project <name>]
```

Examples:
```bash
~/.goldfish/bin/goldfish map:search "authentication"
~/.goldfish/bin/goldfish map:search "database handlers"
```

## Display Rules

1. Show the directory map as-is (already formatted as `dir/ — summary`)
2. If no map exists, suggest `/map:scan`
3. Use map:detail for file-level exploration of a specific directory
4. Use map:search when looking for a concept rather than a path
