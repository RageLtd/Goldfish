/**
 * PostToolUse hook - captures tool observations.
 */

import type { PostToolUseInput } from "../types/hooks";
import { processSaveHook } from "./logic";
import { runHook } from "./runner";

runHook<PostToolUseInput>(processSaveHook);
