---
description: Remove stale, duplicate, and low-score memories
category: memory
allowed-tools: Bash(goldfish:*), Bash(which:*)
---

# Prune Memories

Run the goldfish prune command to clean up stale, duplicate, and low-relevance observations.

## Steps

1. First, check if the goldfish binary is available:

!which goldfish || echo "goldfish binary not found — run 'bun run build' first"

2. Run a dry run to preview what would be pruned:

!goldfish prune

3. Show the user the dry run output and ask if they want to proceed with actual deletion.

4. If the user confirms, run with `--confirm`:

!goldfish prune --confirm

## Pruning Strategies

Three phases applied in sequence:

1. **Age-based** — observations older than 90 days (env: `GOLDFISH_PRUNE_MAX_AGE_DAYS`)
2. **Deduplication** — near-duplicate embeddings, default cosine > 0.92 (env: `GOLDFISH_PRUNE_DEDUP_THRESHOLD`)
3. **Score-based** — observations below relevance threshold 0.2 (env: `GOLDFISH_PRUNE_MIN_SCORE`)

## Output Rules

1. Always show the dry run output first.
2. Never run `--confirm` without explicit user approval.
3. Report the final counts: aged + duplicates + low-score = total removed.
