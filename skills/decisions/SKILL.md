---
name: decisions
description: Retrieve past architectural and design decisions. Use proactively before making architectural choices, when the user asks "why did we...", or to check if a similar decision was already made.
---

# Decisions Skill

Retrieve architectural and design decisions from the goldfish memory database.

## When to Use

- **Proactively** before proposing architectural changes — check if a relevant decision exists
- User asks "why did we choose X?", "what decisions have we made?"
- Before introducing a new pattern — verify it doesn't contradict a past decision
- When reviewing code that seems unusual — a decision record may explain the reasoning

## CLI

```bash
goldfish decisions [--project <name>] [--limit N] [--since <filter>]
```

Defaults to current project. Since filters: `today`, `yesterday`, `7d`, `30d`, `2w`, ISO date, epoch.

### Fetch Full Decision Details

```bash
goldfish observation <id>
```

## Examples

```bash
goldfish decisions
goldfish decisions --since 7d
goldfish decisions --project myapp --limit 10
goldfish observation 42
```

## Display Rules

1. Start with: "Found N decisions for PROJECT"
2. List each with title, narrative summary, and relative time
3. Fetch full observation by ID when you need detailed rationale
4. If none found, say so and note the current decision will be recorded automatically

## Example Workflow

1. User asks: "Should we use Redis or in-memory caching?"
2. Check existing decisions: `goldfish decisions`
3. If a caching decision exists, reference it
4. If not, proceed — the decision will be recorded automatically
