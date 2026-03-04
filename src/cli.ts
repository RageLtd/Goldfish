#!/usr/bin/env bun
/**
 * Unified CLI for goldfish.
 * Single binary with subcommands to reduce plugin size.
 *
 * Usage:
 *   goldfish <command> [args]
 *
 * Commands:
 *   hook:context    - SessionStart hook (inject context)
 *   hook:new        - UserPromptSubmit hook (create session)
 *   hook:save       - PostToolUse hook (save observations)
 *   hook:summary    - Stop hook (generate summary)
 *   hook:cleanup    - SessionEnd hook (cleanup)
 *   worker          - Start HTTP worker service
 *   backfill        - Compute embeddings for observations without them
 *   graph:backfill  - Create edges for observations with embeddings but no edges
 *   graph:stats     - Show knowledge graph statistics
 *   graph:show      - Show observation neighborhood in the graph
 *   prune           - Remove stale, duplicate, and low-score observations
 *   search          - Search observations or summaries
 *   timeline        - Show recent activity timeline
 *   decisions       - Show architectural decisions
 *   find            - Find observations related to a file
 *   observation     - Fetch a single observation by ID
 *   health          - Check worker status
 *   version         - Show version
 */

import pkg from "../package.json";

const COMMANDS: Record<string, () => Promise<void>> = {
  "hook:context": async () => {
    const { main } = await import("./hooks/context-hook");
    await main();
  },
  "hook:new": async () => {
    const { main } = await import("./hooks/new-hook");
    await main();
  },
  "hook:save": async () => {
    const { main } = await import("./hooks/save-hook");
    await main();
  },
  "hook:summary": async () => {
    const { main } = await import("./hooks/summary-hook");
    await main();
  },
  "hook:cleanup": async () => {
    const { main } = await import("./hooks/cleanup-hook");
    await main();
  },
  worker: async () => {
    const { main } = await import("./worker/main");
    await main();
  },
  backfill: async () => {
    const { main } = await import("./commands/backfill");
    await main();
  },
  "graph:backfill": async () => {
    const { main } = await import("./commands/graph");
    await main();
  },
  prune: async () => {
    const { main } = await import("./commands/prune");
    await main();
  },
  search: async () => {
    const { searchMain } = await import("./commands/query");
    await searchMain();
  },
  timeline: async () => {
    const { timelineMain } = await import("./commands/query");
    await timelineMain();
  },
  decisions: async () => {
    const { decisionsMain } = await import("./commands/query");
    await decisionsMain();
  },
  find: async () => {
    const { findMain } = await import("./commands/query");
    await findMain();
  },
  observation: async () => {
    const { observationMain } = await import("./commands/query");
    await observationMain();
  },
  health: async () => {
    const { healthMain } = await import("./commands/query");
    await healthMain();
  },
  "graph:stats": async () => {
    const { graphStatsMain } = await import("./commands/query");
    await graphStatsMain();
  },
  "graph:show": async () => {
    const { graphShowMain } = await import("./commands/query");
    await graphShowMain();
  },
  version: async () => {
    console.log(`goldfish v${pkg.version}`);
  },
};

const showHelp = () => {
  console.log(`goldfish v${pkg.version}

Usage: goldfish <command>

Commands:
  hook:context    SessionStart hook - inject past context
  hook:new        UserPromptSubmit hook - create/continue session
  hook:save       PostToolUse hook - save tool observations
  hook:summary    Stop hook - generate session summary
  hook:cleanup    SessionEnd hook - cleanup session
  worker          Start HTTP worker service
  backfill        Compute embeddings for observations without them
  graph:backfill  Create edges for observations with embeddings but no edges
  graph:stats     Show knowledge graph statistics
  graph:show      Show observation neighborhood in the graph
  prune           Remove stale, duplicate, and low-score observations
  search          Search observations or summaries
  timeline        Show recent activity timeline
  decisions       Show architectural decisions
  find            Find observations related to a file
  observation     Fetch a single observation by ID
  health          Check worker status
  version         Show version

Query commands (require running worker):
  goldfish search <query> [--type observations|summaries] [--concept ...] [--project ...] [--limit N]
  goldfish timeline [--project ...] [--limit N] [--since ...]
  goldfish decisions [--project ...] [--limit N] [--since ...]
  goldfish find <file> [--limit N]
  goldfish observation <id>
  goldfish health
  goldfish graph:stats
  goldfish graph:show <id>
`);
};

const main = async () => {
  const command = process.argv[2];

  if (!command || command === "--help" || command === "-h") {
    showHelp();
    process.exit(0);
  }

  const handler = COMMANDS[command];
  if (!handler) {
    console.error(`Unknown command: ${command}`);
    console.error(`Run 'goldfish --help' for usage`);
    process.exit(1);
  }

  await handler();
};

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exit(1);
});
