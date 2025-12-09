/**
 * Stop hook - triggers session summary.
 */

import type { StopInput } from "../types/hooks";
import { processSummaryHook } from "./logic";
import { runHook } from "./runner";

runHook<StopInput>(processSummaryHook);
