---
name: graph-show
description: Show the neighborhood of an observation in the knowledge graph. Use when the user asks "what's connected to this observation?", "show graph neighbors", or wants to explore relationships between observations.
---

# Graph Show Skill

Show the neighborhood of an observation in the knowledge graph.

## When to Use

- "What observations are connected to #42?"
- "Show the graph neighborhood for this observation"
- "What's related to observation 100?"
- Exploring connections between past observations

## CLI

```bash
~/.goldfish/bin/goldfish graph:show <id>
```

Returns the observation ID and its neighbors with titles, relation types, weights, and directions.

## Examples

```bash
~/.goldfish/bin/goldfish graph:show 42
~/.goldfish/bin/goldfish graph:show 764
```

## Display Rules

1. Show the target observation ID and its neighbor count
2. List neighbors with their titles, relation types, and weights
3. If no neighbors found, tell the user the observation has no graph connections
4. If the observation doesn't exist in the graph, report it
