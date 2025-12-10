/**
 * Stop hook - triggers session summary.
 */

import type { StopInput } from "../types/hooks";
import { processSummaryHook } from "./logic";
import { runHook } from "./runner";

export const main = () =>
	runHook<StopInput>(processSummaryHook, "summary-hook");

// Run directly if executed as script
if (import.meta.main) {
	main();
}
