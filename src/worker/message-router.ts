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
  updateObservationGraphMetadata,
  updateSessionStatus,
} from "../db/index";
import type { GraphManager } from "../graph/index";
import { createEdges } from "../graph/index";
import { buildEmbeddingText } from "../utils/embedding";
import type { EmbeddingCache } from "./embedding-cache";
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

export interface LinkData {
  readonly observationId: number;
}

export interface MapResummarizeData {
  readonly project: string;
  readonly projectRoot: string;
  readonly directory: string;
}

export interface MapRefreshData {
  readonly project: string;
  readonly projectRoot: string;
}

export type RouterMessageType =
  | "observation"
  | "summarize"
  | "complete"
  | "embed"
  | "link"
  | "prune"
  | "map-resummarize"
  | "map-refresh";

export interface RouterMessage {
  readonly type: RouterMessageType;
  readonly claudeSessionId: string;
  readonly data:
    | ObservationData
    | SummarizeData
    | CompleteData
    | EmbedData
    | LinkData
    | PruneData
    | MapResummarizeData
    | MapRefreshData;
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
  readonly graphManager?: GraphManager;
  readonly embeddingCache?: EmbeddingCache;
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
      } else {
        // Update in-memory cache so queries see new embeddings immediately
        if (deps.embeddingCache) {
          const obs = getObservationById(db, data.observationId);
          if (obs.ok && obs.value) {
            deps.embeddingCache.set(data.observationId, {
              id: data.observationId,
              title: obs.value.title,
              narrative: obs.value.narrative,
              project: obs.value.project,
              type: obs.value.type,
              createdAtEpoch: obs.value.createdAtEpoch,
              sdkSessionId: obs.value.sdkSessionId,
              embedding,
            });
          }
        }
        if (deps.graphManager) {
          // Enqueue edge creation after embedding is stored
          deps.enqueue({
            type: "link",
            claudeSessionId: msg.claudeSessionId,
            data: { observationId: data.observationId },
          });
        }
      }
      return;
    }

    // Link messages run edge creation pipeline — no session context needed
    if (msg.type === "link") {
      const data = msg.data as LinkData;
      if (deps.graphManager) {
        const result = await createEdges(
          db,
          deps.graphManager,
          { observationId: data.observationId },
          deps.modelManager,
        );
        if (!result.ok) {
          log(
            `Failed to create edges for #${data.observationId}: ${result.error.message}`,
          );
        }
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
      // Clean up in-memory caches for deleted nodes
      if (result.deletedIds.length > 0) {
        if (deps.embeddingCache) {
          for (const id of result.deletedIds) {
            deps.embeddingCache.delete(id);
          }
        }
      }
      if (deps.graphManager && result.deletedIds.length > 0) {
        for (const id of result.deletedIds) {
          deps.graphManager.removeNode(id);
        }
        const metadata = deps.graphManager.recomputeMetadata();
        for (const [nodeId, meta] of metadata) {
          updateObservationGraphMetadata(db, {
            id: nodeId,
            centrality: meta.centrality,
            community: meta.community,
            degree: meta.degree,
          });
        }
      }

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

    // Map re-summarize: re-generate a directory summary after file changes
    if (msg.type === "map-resummarize") {
      const data = msg.data as MapResummarizeData;
      // Dynamic import to avoid circular dependency
      const { scanProject } = await import("../codebase-map/scanner");
      const { summarizeDirectories } = await import(
        "../codebase-map/summarizer"
      );

      const scanResult = await scanProject(data.projectRoot);
      if (!scanResult.ok) {
        log(`Map re-scan failed: ${scanResult.error.message}`);
        return;
      }

      // Only re-summarize the directory that changed
      const targetDir = scanResult.value.directories.find(
        (d) => d.relativePath === data.directory,
      );
      if (targetDir) {
        await summarizeDirectories(
          {
            db,
            modelManager: deps.modelManager,
            projectRoot: data.projectRoot,
            project: data.project,
          },
          [targetDir],
        );
        log(`Re-summarized directory: ${data.directory}`);
      }
      return;
    }

    // Map refresh: scan project for stale files, enqueue re-summarization per directory
    if (msg.type === "map-refresh") {
      const data = msg.data as MapRefreshData;
      const { scanProject } = await import("../codebase-map/scanner");
      const { getStaleEntries } = await import("../db/codebase-map");

      const scanResult = await scanProject(data.projectRoot);
      if (!scanResult.ok) {
        log(`Map refresh scan failed: ${scanResult.error.message}`);
        return;
      }

      // Build current hash map from scan
      const currentHashes = new Map<string, string>();
      for (const dir of scanResult.value.directories) {
        for (const file of dir.files) {
          currentHashes.set(file.relativePath, file.hash);
        }
      }

      const staleResult = getStaleEntries(db, data.project, currentHashes);
      if (!staleResult.ok || staleResult.value.length === 0) {
        return;
      }

      // Collect unique directories that need re-summarization
      const staleDirs = new Set<string>();
      for (const entry of staleResult.value) {
        const lastSlash = entry.path.lastIndexOf("/");
        staleDirs.add(lastSlash >= 0 ? entry.path.slice(0, lastSlash) : ".");
      }

      log(
        `Map refresh: ${staleResult.value.length} stale files in ${staleDirs.size} directories`,
      );

      for (const dir of staleDirs) {
        deps.enqueue({
          type: "map-resummarize",
          claudeSessionId: "",
          data: {
            project: data.project,
            projectRoot: data.projectRoot,
            directory: dir,
          },
        });
      }
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
