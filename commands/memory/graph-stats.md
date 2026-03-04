---
description: Show knowledge graph statistics (nodes, edges, communities, top central observations)
category: memory
allowed-tools: Bash(goldfish:*)
---

# Graph Stats

Show statistics about the knowledge graph.

!goldfish graph:stats

## Output Rules

1. If the command fails with a connection error, suggest starting the worker with `goldfish worker`.
2. Otherwise, report:
   - **nodes**: total observation nodes in the graph
   - **edges**: total edges connecting observations
   - **communities**: number of detected communities
   - **topCentral**: list the top central observations with their title, centrality score, and degree
3. If nodes is 0, tell the user no graph data exists yet and suggest running `goldfish graph:backfill`.
