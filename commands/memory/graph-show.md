---
description: Show an observation's neighborhood in the knowledge graph
category: memory
allowed-tools: Bash(goldfish:*)
---

# Graph Show

Show the neighborhood of an observation in the knowledge graph.

!goldfish graph:show $ARGUMENTS

## Output Rules

1. If no argument is provided, ask the user for an observation ID.
2. If the command fails with a connection error, suggest starting the worker with `goldfish worker`.
3. Otherwise, display:
   - The observation ID and total neighbor count
   - Each neighbor's title, relation type, weight, and direction
4. If neighbors is empty, tell the user this observation has no graph connections.
