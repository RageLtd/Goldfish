/**
 * SessionEnd hook - marks session as completed.
 */

import type { SessionEndInput } from "../types/hooks";
import { processCleanupHook } from "./logic";
import { runHook } from "./runner";

export const main = () =>
	runHook<SessionEndInput>(processCleanupHook, "cleanup-hook");

// Run directly if executed as script
if (import.meta.main) {
	main();
}
