/**
 * Message router — sequential FIFO queue for processing hook messages.
 * Replaces SessionManager + BackgroundProcessor with ~80 lines.
 *
 * Messages are processed one at a time through the local llama.cpp model.
 * No timers, no polling, no per-session state. Drain triggered at enqueue time.
 */

import {
  getObservationById,
  getSessionByClaudeId,
  updateObservationEmbedding,
  updateSessionStatus,
} from "../db/index";
import { buildEmbeddingText } from "../utils/embedding";
import {
  type LocalAgentDeps,
  processObservation,
  processSummary,
  type SessionContext,
} from "./local-agent";

export interface ObservationData {
  readonly toolName: string;
  readonly toolInput: unknown;
  readonly toolResponse: unknown;
  readonly cwd: string;
}

export interface SummarizeData {
  readonly lastUserMessage: string;
  readonly lastAssistantMessage?: string;
}

export interface CompleteData {
  readonly reason: string;
}

export interface EmbedData {
  readonly observationId: number;
  readonly title: string;
  readonly narrative: string;
}

export interface PruneData {
  readonly maxAgeDays: number;
  readonly dedupThreshold: number;
  readonly minScore: number;
}

export type RouterMessageType =
  | "observation"
  | "summarize"
  | "complete"
  | "embed"
  | "prune";

export interface RouterMessage {
  readonly type: RouterMessageType;
  readonly claudeSessionId: string;
  readonly data:
    | ObservationData
    | SummarizeData
    | CompleteData
    | EmbedData
    | PruneData;
}

export interface MessageRouterDeps {
  readonly processMessage: (msg: RouterMessage) => Promise<void>;
}

export interface MessageRouter {
  readonly enqueue: (msg: RouterMessage) => void;
  readonly shutdown: () => Promise<void>;
  readonly pending: () => number;
}

// ============================================================================
// Factory
// ============================================================================

const log = (msg: string) => console.log(`[router] ${msg}`);

export const createMessageRouter = (deps: MessageRouterDeps): MessageRouter => {
  const queue: RouterMessage[] = [];
  let drainPromise: Promise<void> | null = null;

  const drain = async () => {
    for (let msg = queue.shift(); msg; msg = queue.shift()) {
      try {
        await deps.processMessage(msg);
      } catch (e) {
        log(
          `Error processing ${msg.type} for ${msg.claudeSessionId}: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
    }
    drainPromise = null;
  };

  return {
    enqueue: (msg: RouterMessage) => {
      queue.push(msg);
      if (!drainPromise) {
        drainPromise = drain();
      }
    },
    shutdown: () => drainPromise ?? Promise.resolve(),
    pending: () => queue.length,
  };
};

// ============================================================================
// Process message dispatcher
// ============================================================================

export interface ProcessMessageDeps extends LocalAgentDeps {
  readonly enqueue: (msg: RouterMessage) => void;
}

/** Auto-prune defaults (read from env at module load) */
const AUTO_PRUNE_MAX_AGE_DAYS = parseInt(
  process.env.GOLDFISH_PRUNE_MAX_AGE_DAYS || "90",
  10,
);
const AUTO_PRUNE_DEDUP_THRESHOLD = parseFloat(
  process.env.GOLDFISH_PRUNE_DEDUP_THRESHOLD || "0.92",
);
const AUTO_PRUNE_MIN_SCORE = parseFloat(
  process.env.GOLDFISH_PRUNE_MIN_SCORE || "0.2",
);

/** Rate-limit auto-prune: run at most once per 24 hours */
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface LastPruneStats {
  readonly epoch: number;
  readonly aged: number;
  readonly duplicates: number;
  readonly lowScore: number;
  readonly deleted: number;
}

/** Module-level last prune stats, queryable by handlers. */
let _lastPruneStats: LastPruneStats | null = null;

export const getLastPruneStats = (): LastPruneStats | null => _lastPruneStats;

export const createProcessMessage = (
  deps: ProcessMessageDeps,
): ((msg: RouterMessage) => Promise<void>) => {
  let lastPruneEpoch = 0;

  return async (msg: RouterMessage): Promise<void> => {
    const { db } = deps;

    // Embed messages only need observation ID + model — no session context
    if (msg.type === "embed") {
      const data = msg.data as EmbedData;
      const text = buildEmbeddingText(data);
      const embedding = await deps.modelManager.computeEmbedding(text);
      const result = updateObservationEmbedding(
        db,
        data.observationId,
        embedding,
      );
      if (!result.ok) {
        log(
          `Failed to store embedding for #${data.observationId}: ${result.error.message}`,
        );
      }
      return;
    }

    // Prune messages run inline — no session context needed
    if (msg.type === "prune") {
      const data = msg.data as PruneData;
      // Dynamic import to avoid circular dependency
      const { runPrune } = await import("../commands/prune");
      const result = runPrune(db, {
        maxAgeDays: data.maxAgeDays,
        dedupThreshold: data.dedupThreshold,
        minScore: data.minScore,
        dryRun: false,
      });
      _lastPruneStats = {
        epoch: Date.now(),
        aged: result.aged,
        duplicates: result.duplicates,
        lowScore: result.lowScore,
        deleted: result.deleted,
      };
      log(
        `Auto-prune complete: ${result.deleted} deleted (${result.aged} aged, ${result.duplicates} dups, ${result.lowScore} low-score)`,
      );
      return;
    }

    const sessionResult = getSessionByClaudeId(db, msg.claudeSessionId);
    if (!sessionResult.ok || !sessionResult.value) {
      log(`Session not found for ${msg.claudeSessionId}, skipping`);
      return;
    }

    const session = sessionResult.value;
    const context: SessionContext = {
      claudeSessionId: msg.claudeSessionId,
      project: session.project,
      promptNumber: session.promptCounter || 1,
    };

    if (msg.type === "observation") {
      const data = msg.data as ObservationData;
      const obsResult = await processObservation(deps, context, {
        toolName: data.toolName,
        toolInput: data.toolInput,
        toolResponse: data.toolResponse,
        cwd: data.cwd,
        occurredAt: new Date().toISOString(),
      });

      // Enqueue embedding computation for newly stored observations
      if (obsResult.ok && obsResult.value !== null) {
        const obsId = obsResult.value;
        const obsData = getObservationById(db, obsId);
        if (obsData.ok && obsData.value) {
          deps.enqueue({
            type: "embed",
            claudeSessionId: msg.claudeSessionId,
            data: {
              observationId: obsId,
              title: obsData.value.title ?? "",
              narrative: obsData.value.narrative ?? "",
            },
          });
        }
      }
      return;
    }

    if (msg.type === "summarize") {
      const data = msg.data as SummarizeData;
      await processSummary(deps, context, {
        lastUserMessage: data.lastUserMessage,
        lastAssistantMessage: data.lastAssistantMessage,
      });
      return;
    }

    if (msg.type === "complete") {
      updateSessionStatus(db, session.id, "completed");

      // Rate-limited auto-prune on session completion
      const now = Date.now();
      if (now - lastPruneEpoch >= PRUNE_INTERVAL_MS) {
        lastPruneEpoch = now;
        deps.enqueue({
          type: "prune",
          claudeSessionId: msg.claudeSessionId,
          data: {
            maxAgeDays: AUTO_PRUNE_MAX_AGE_DAYS,
            dedupThreshold: AUTO_PRUNE_DEDUP_THRESHOLD,
            minScore: AUTO_PRUNE_MIN_SCORE,
          },
        });
      }
    }
  };
};
