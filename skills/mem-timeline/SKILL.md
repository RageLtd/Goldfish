---
name: mem-timeline
description: Show a chronological timeline of recent observations and summaries. Use when the user asks "what happened recently?", "show recent activity", or "what did we work on today/this week?".
---

# Memory Timeline Skill

Show chronological activity from the goldfish memory database.

## When to Use

- "What happened recently?"
- "What did we work on today?"
- "Show me this week's activity"
- "What changed since yesterday?"

## CLI

```bash
~/.goldfish/bin/goldfish timeline [--project <name>] [--limit N] [--since <filter>]
```

Defaults to current project. Since filters: `today`, `yesterday`, `7d`, `30d`, `2w`, ISO date, epoch.

## Examples

```bash
~/.goldfish/bin/goldfish timeline --since today
~/.goldfish/bin/goldfish timeline --since 7d --limit 30
~/.goldfish/bin/goldfish timeline --project myapp --since yesterday
```

## Display Rules

1. Show items chronologically, most recent first
2. For each item: relative time, kind (observation/summary), type, title
3. Include narrative excerpt if available
4. If empty, tell the user no recent activity was found
