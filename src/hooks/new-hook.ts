/**
 * UserPromptSubmit hook - captures user prompts.
 */

import type { UserPromptSubmitInput } from "../types/hooks";
import { processNewHook } from "./logic";
import { runHook } from "./runner";

export const main = () =>
  runHook<UserPromptSubmitInput>(processNewHook, "new-hook");

// Run directly if executed as script
if (import.meta.main) {
  main();
}
