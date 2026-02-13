/**
 * PostToolUse hook - captures tool observations.
 */

import type { PostToolUseInput } from "../types/hooks";
import { processSaveHook } from "./logic";
import { runHook } from "./runner";

export const main = () =>
  runHook<PostToolUseInput>(processSaveHook, "save-hook");

// Run directly if executed as script
if (import.meta.main) {
  main();
}
