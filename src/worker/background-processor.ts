/**
 * BackgroundProcessor - Manages session processing with proper cleanup.
 * Tracks active processing to prevent memory leaks and enable graceful shutdown.
 */

import type {
  PendingInputMessage,
  SDKAgent,
  SDKAgentMessage,
} from "./sdk-agent";
import type {
  ActiveSession,
  ContinuationMessage,
  ObservationMessage,
  PendingMessage,
  SessionManager,
  SummarizeMessage,
} from "./session-manager";

// ============================================================================
// Types
// ============================================================================

export interface BackgroundProcessorDeps {
  readonly sessionManager: SessionManager;
  readonly sdkAgent: SDKAgent;
  readonly pollIntervalMs?: number;
  readonly onObservationStored?: (
    sessionId: string,
    observationId: number,
  ) => void;
  readonly onSummaryStored?: (sessionId: string, summaryId: number) => void;
  readonly onError?: (sessionId: string, error: string) => void;
}

export interface BackgroundProcessor {
  readonly start: () => void;
  readonly stop: () => void;
  readonly getActiveProcessingCount: () => number;
  readonly awaitCompletion: (timeoutMs: number) => Promise<void>;
}

// ============================================================================
// Message Transformation
// ============================================================================

const transformMessage = (msg: PendingMessage): PendingInputMessage => {
  if (msg.type === "observation") {
    const data = msg.data as ObservationMessage;
    return {
      type: "observation",
      data: { observation: data.observation },
    };
  }
  if (msg.type === "summarize") {
    const data = msg.data as SummarizeMessage;
    return {
      type: "summarize",
      data: {
        lastUserMessage: data.lastUserMessage,
        lastAssistantMessage: data.lastAssistantMessage,
      },
    };
  }
  // continuation
  const data = msg.data as ContinuationMessage;
  return {
    type: "continuation",
    data: {
      userPrompt: data.userPrompt,
      promptNumber: data.promptNumber,
    },
  };
};

// ============================================================================
// Factory
// ============================================================================

export const createBackgroundProcessor = (
  deps: BackgroundProcessorDeps,
): BackgroundProcessor => {
  const {
    sessionManager,
    sdkAgent,
    pollIntervalMs = 1000,
    onObservationStored,
    onSummaryStored,
    onError,
  } = deps;

  // Track active processing by session DB ID
  const activeProcessing = new Map<number, Promise<void>>();
  let pollInterval: ReturnType<typeof setInterval> | null = null;
  let isRunning = false;

  /**
   * Process a single session's messages.
   */
  const processSession = async (session: ActiveSession): Promise<void> => {
    const iterator = sessionManager.getMessageIterator(session.sessionDbId);
    if (!iterator) return;

    // Create transformed iterator for SDK agent
    const inputMessages: AsyncIterable<PendingInputMessage> = {
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          const result = await iterator.next();
          if (result.done) {
            return { done: true as const, value: undefined };
          }
          return {
            done: false as const,
            value: transformMessage(result.value),
          };
        },
      }),
    };

    // Process messages
    for await (const output of sdkAgent.processMessages(
      session,
      inputMessages,
    )) {
      handleOutput(session.claudeSessionId, output);
    }
  };

  /**
   * Handle SDK agent output messages.
   */
  const handleOutput = (
    claudeSessionId: string,
    output: SDKAgentMessage,
  ): void => {
    if (output.type === "observation_stored") {
      const data = output.data as { id: number };
      onObservationStored?.(claudeSessionId, data.id);
    } else if (output.type === "summary_stored") {
      const data = output.data as { id: number };
      onSummaryStored?.(claudeSessionId, data.id);
    } else if (output.type === "error") {
      onError?.(claudeSessionId, String(output.data));
    }
  };

  /**
   * Poll for active sessions and start processing.
   */
  const pollActiveSessions = (): void => {
    for (const session of sessionManager.getActiveSessions()) {
      // Skip if already processing this session
      if (activeProcessing.has(session.sessionDbId)) {
        continue;
      }

      // Start processing and track the promise
      const processingPromise = processSession(session)
        .catch((error) => {
          onError?.(
            session.claudeSessionId,
            error instanceof Error ? error.message : String(error),
          );
        })
        .finally(() => {
          // Clean up tracking when done
          activeProcessing.delete(session.sessionDbId);
        });

      activeProcessing.set(session.sessionDbId, processingPromise);
    }
  };

  /**
   * Start the background processor.
   */
  const start = (): void => {
    if (isRunning) return;
    isRunning = true;
    pollInterval = setInterval(pollActiveSessions, pollIntervalMs);
    // Run immediately on start
    pollActiveSessions();
  };

  /**
   * Stop the background processor.
   */
  const stop = (): void => {
    if (pollInterval) {
      clearInterval(pollInterval);
      pollInterval = null;
    }
    isRunning = false;
  };

  /**
   * Get the count of actively processing sessions.
   */
  const getActiveProcessingCount = (): number => {
    return activeProcessing.size;
  };

  /**
   * Wait for all active processing to complete, with timeout.
   */
  const awaitCompletion = async (timeoutMs: number): Promise<void> => {
    if (activeProcessing.size === 0) return;

    const allProcessing = Promise.all(activeProcessing.values());
    const timeout = new Promise<void>((resolve) =>
      setTimeout(resolve, timeoutMs),
    );

    await Promise.race([allProcessing, timeout]);
  };

  return {
    start,
    stop,
    getActiveProcessingCount,
    awaitCompletion,
  };
};
