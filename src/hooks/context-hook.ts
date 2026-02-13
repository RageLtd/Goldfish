/**
 * SessionStart hook - injects context into new sessions.
 */

import type { SessionStartInput } from "../types/hooks";
import { processContextHook } from "./logic";
import { runHook } from "./runner";

export const main = () =>
  runHook<SessionStartInput>(processContextHook, "context-hook");

// Run directly if executed as script
if (import.meta.main) {
  main();
}
