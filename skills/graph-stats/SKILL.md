---
name: graph-stats
description: Show knowledge graph statistics including node/edge counts, communities, and most central observations. Use when the user asks "how big is the graph?", "show graph stats", or wants an overview of the knowledge graph.
---

# Graph Stats Skill

Show statistics about the goldfish knowledge graph.

## When to Use

- "How big is the knowledge graph?"
- "Show graph statistics"
- "What are the most connected observations?"
- "How many communities are there?"

## CLI

```bash
~/.goldfish/bin/goldfish graph:stats
```

Returns node count, edge count, community count, and top 10 most central observations.

## Examples

```bash
~/.goldfish/bin/goldfish graph:stats
```

## Display Rules

1. Show total nodes, edges, and communities as a summary
2. List top central observations with their titles, centrality, and degree
3. If the graph is empty, tell the user no graph data exists yet
