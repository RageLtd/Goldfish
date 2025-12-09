/**
 * SessionStart hook - injects context into new sessions.
 */

import type { SessionStartInput } from "../types/hooks";
import { processContextHook } from "./logic";
import { runHook } from "./runner";

runHook<SessionStartInput>(processContextHook);
