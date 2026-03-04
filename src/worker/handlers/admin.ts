/**
 * Admin handlers: health, backfill, backfill status, shutdown.
 */

import { getObservationsWithoutEmbeddings } from "../../db/index";
import { getLastPruneStats } from "../message-router";
import type { HandlerResponse, HealthCheckResponse, WorkerDeps } from "./types";

/**
 * Health check endpoint with metadata.
 */
export const handleHealth = async (
  deps: WorkerDeps,
): Promise<HandlerResponse<HealthCheckResponse>> => {
  const now = Date.now();
  const uptimeSeconds = deps.startedAt
    ? Math.floor((now - deps.startedAt) / 1000)
    : 0;
  const pendingMessages = deps.router?.pending() ?? 0;

  return {
    status: 200,
    body: {
      status: "ok",
      version: deps.version || "unknown",
      uptimeSeconds,
      pendingMessages,
      lastPrune: getLastPruneStats(),
    },
  };
};

/**
 * Enqueue embedding computation for observations that lack embeddings.
 * Fire-and-forget — returns immediately after enqueuing.
 */
export const handleBackfill = async (
  deps: WorkerDeps,
): Promise<HandlerResponse> => {
  const batchResult = getObservationsWithoutEmbeddings(deps.db, { limit: 500 });
  if (!batchResult.ok) {
    return { status: 500, body: { error: batchResult.error.message } };
  }

  const batch = batchResult.value;
  if (!deps.router || batch.length === 0) {
    return { status: 200, body: { enqueued: 0 } };
  }

  for (const obs of batch) {
    deps.router.enqueue({
      type: "embed",
      claudeSessionId: "",
      data: {
        observationId: obs.id,
        title: obs.title ?? "",
        narrative: obs.narrative ?? "",
      },
    });
  }

  return { status: 200, body: { enqueued: batch.length } };
};

/**
 * Check how many observations still lack embeddings.
 */
export const handleBackfillStatus = async (
  deps: WorkerDeps,
): Promise<HandlerResponse> => {
  const result = getObservationsWithoutEmbeddings(deps.db, { limit: 10000 });
  if (!result.ok) {
    return { status: 500, body: { error: result.error.message } };
  }

  return {
    status: 200,
    body: {
      remaining: result.value.length,
      pendingMessages: deps.router?.pending() ?? 0,
    },
  };
};

/**
 * Graceful shutdown endpoint.
 * Returns immediately, then triggers shutdown via callback.
 */
export const handleShutdown = async (
  _deps: WorkerDeps,
  onShutdown: () => void,
): Promise<HandlerResponse<{ readonly status: string }>> => {
  // Schedule shutdown after response is sent
  setTimeout(onShutdown, 50);
  return {
    status: 200,
    body: { status: "shutting_down" },
  };
};
