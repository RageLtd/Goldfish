---
name: mem-detail
description: Fetch the full content of a specific observation by ID. Use when you need implementation details, rationale, or debugging context from an observation shown in the index.
---

# Observation Detail Skill

Fetch the full content of a specific observation from the goldfish memory database.

## When to Use

- You see an observation in the index and need its full narrative or details
- The user asks for details about a specific past observation
- You need implementation specifics or rationale from a past session

## CLI

```bash
~/.goldfish/bin/goldfish observation <id>
```

Returns the full formatted observation including title, narrative, facts, concepts, and files.

## Examples

```bash
~/.goldfish/bin/goldfish observation 42
~/.goldfish/bin/goldfish observation 2175
```

## Display Rules

1. Show the formatted observation content directly
2. If the observation is not found, report the error
