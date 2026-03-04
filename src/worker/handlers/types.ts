/**
 * Shared types and helpers for worker handlers.
 */

import type { Database } from "bun:sqlite";
import type { GraphManager } from "../../graph/index";
import type { ModelManager } from "../../models/manager";
import type { LastPruneStats, MessageRouter } from "../message-router";

// ============================================================================
// Dependencies
// ============================================================================

export interface WorkerDeps {
  readonly db: Database;
  readonly router?: MessageRouter;
  readonly modelManager?: ModelManager;
  readonly graphManager?: GraphManager;
  readonly startedAt?: number;
  readonly version?: string;
}

export interface HandlerResponse<T = unknown> {
  readonly status: number;
  readonly body: T;
}

// ============================================================================
// Input types
// ============================================================================

export interface QueueObservationInput {
  readonly claudeSessionId: string;
  readonly toolName: string;
  readonly toolInput: unknown;
  readonly toolResponse: unknown;
  readonly cwd: string;
}

export interface QueueSummaryInput {
  readonly claudeSessionId: string;
  readonly lastUserMessage: string;
  readonly lastAssistantMessage: string;
  readonly transcriptPath?: string;
}

export interface CompleteSessionInput {
  readonly claudeSessionId: string;
  readonly reason: string;
}

export type ContextFormat = "index" | "full";

export interface GetContextInput {
  readonly project: string;
  readonly limit: number;
  readonly format?: ContextFormat;
  readonly since?: string;
}

export interface SearchInput {
  readonly query: string;
  readonly type: "observations" | "summaries";
  readonly concept?: string;
  readonly project?: string;
  readonly limit: number;
  readonly format?: ContextFormat;
}

export interface TimelineInput {
  readonly project?: string;
  readonly limit: number;
  readonly since?: string;
}

export interface DecisionsInput {
  readonly project?: string;
  readonly limit: number;
  readonly since?: string;
}

export interface GetObservationInput {
  readonly id: number;
}

export interface GraphNeighborsInput {
  readonly id: number;
  readonly depth?: number;
}

export interface FindByFileInput {
  readonly file: string;
  readonly limit: number;
}

export interface RetrieveInput {
  readonly prompt: string;
  readonly project: string;
  readonly limit: number;
  readonly sessionId?: string;
}

export interface HealthCheckResponse {
  readonly status: string;
  readonly version: string;
  readonly uptimeSeconds: number;
  readonly pendingMessages: number;
  readonly lastPrune: LastPruneStats | null;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Enqueues embed messages for observations that lack embeddings.
 * Used by handlers to lazily backfill embeddings.
 */
export const enqueueMissingEmbeddings = (
  router: MessageRouter,
  observations: readonly {
    readonly id: number;
    readonly sdkSessionId: string;
    readonly title: string | null;
    readonly narrative: string | null;
  }[],
  existingIds: Set<number>,
): void => {
  for (const obs of observations) {
    if (existingIds.has(obs.id) || !obs.title) continue;
    router.enqueue({
      type: "embed",
      claudeSessionId: obs.sdkSessionId,
      data: {
        observationId: obs.id,
        title: obs.title ?? "",
        narrative: obs.narrative ?? "",
      },
    });
  }
};
