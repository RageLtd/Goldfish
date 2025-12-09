/**
 * SessionEnd hook - marks session as completed.
 */

import type { SessionEndInput } from "../types/hooks";
import { processCleanupHook } from "./logic";
import { runHook } from "./runner";

runHook<SessionEndInput>(processCleanupHook);
