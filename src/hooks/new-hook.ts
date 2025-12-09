/**
 * UserPromptSubmit hook - captures user prompts.
 */

import type { UserPromptSubmitInput } from "../types/hooks";
import { processNewHook } from "./logic";
import { runHook } from "./runner";

runHook<UserPromptSubmitInput>(processNewHook);
