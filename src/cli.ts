#!/usr/bin/env bun
/**
 * Unified CLI for claude-mem-bun.
 * Single binary with subcommands to reduce plugin size.
 *
 * Usage:
 *   claude-mem <command> [args]
 *
 * Commands:
 *   hook:context    - SessionStart hook (inject context)
 *   hook:new        - UserPromptSubmit hook (create session)
 *   hook:save       - PostToolUse hook (save observations)
 *   hook:summary    - Stop hook (generate summary)
 *   hook:cleanup    - SessionEnd hook (cleanup)
 *   worker          - Start HTTP worker service
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
  version: async () => {
    console.log(`claude-mem-bun v${pkg.version}`);
  },
};

const showHelp = () => {
  console.log(`claude-mem-bun v${pkg.version}

Usage: claude-mem <command>

Commands:
  hook:context    SessionStart hook - inject past context
  hook:new        UserPromptSubmit hook - create/continue session
  hook:save       PostToolUse hook - save tool observations
  hook:summary    Stop hook - generate session summary
  hook:cleanup    SessionEnd hook - cleanup session
  worker          Start HTTP worker service
  version         Show version

Examples:
  claude-mem worker                    # Start the worker service
  echo '{}' | claude-mem hook:context  # Run context hook with stdin
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
    console.error(`Run 'claude-mem --help' for usage`);
    process.exit(1);
  }

  await handler();
};

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exit(1);
});
