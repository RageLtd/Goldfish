---
name: mem-file
description: Find past observations related to a specific file. Use when the user asks "what do we know about this file?", "show history for user.ts", or when you need context on why a file was changed.
---

# File Memory Skill

Find observations related to a specific file from the goldfish memory database.

## When to Use

- "What changes were made to user.ts?"
- "Show history for this file"
- "What do we know about src/auth.ts?"
- Before modifying a file — check if there's relevant context from past work

## CLI

```bash
goldfish find <file> [--limit N]
```

Searches both `filesRead` and `filesModified` arrays in observations.

## Examples

```bash
goldfish find src/auth.ts
goldfish find handlers.ts --limit 20
goldfish find package.json
```

## Display Rules

1. Show matching observations with title, type, and which operation (read/modified)
2. Include narrative excerpt for context
3. If no results, tell the user no past observations reference this file
