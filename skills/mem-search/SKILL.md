---
name: mem-search
description: Search project memory for past observations and summaries. Use when asked to find specific past work, search for context on a topic, or look up what happened with a particular feature or bug.
---

# Memory Search Skill

Search the goldfish database for observations and summaries from past work.

## When to Use

- User searches for context: "What do you know about authentication?", "Find previous work on the API"
- User asks about past work: "What did we do yesterday?", "Show me recent changes"
- You need to find related past observations on a topic

## CLI Commands

### Search Observations

```bash
goldfish search <query> [--type observations|summaries] [--concept decision|bugfix|feature|refactor|discovery|change] [--project <name>] [--limit N]
```

Examples:
```bash
goldfish search "authentication flow"
goldfish search "database migration" --concept bugfix
goldfish search "API endpoint" --type summaries --limit 5
```

### Get Recent Context

```bash
goldfish timeline [--project <name>] [--limit N] [--since <filter>]
```

Since filters: `today`, `yesterday`, `7d`, `30d`, `2w`, ISO date, epoch.

Examples:
```bash
goldfish timeline --since today
goldfish timeline --since 7d --limit 30
```

## Display Rules

1. Start with a one-line summary: "Found N observations: X decisions, Y features, ..."
2. Only list non-zero types
3. Show results in a concise table or list format

## Progressive Disclosure

Context uses two tiers:
1. **Index** (~20 tokens/observation): titles, types, token estimates
2. **Detail**: full observation fetched by ID via `goldfish observation <id>`

Fetch details only when you need implementation specifics or rationale.
