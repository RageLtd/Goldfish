/**
 * Session-related handlers: queue observation, queue summary, complete session.
 */

import { createSession, getSessionByClaudeId } from "../../db/index";
import { projectFromCwd } from "../../utils/validation";
import type {
  CompleteSessionInput,
  HandlerResponse,
  QueueObservationInput,
  QueueSummaryInput,
  WorkerDeps,
} from "./types";

/**
 * Queue an observation from a tool use.
 */
export const handleQueueObservation = async (
  deps: WorkerDeps,
  input: QueueObservationInput,
): Promise<HandlerResponse> => {
  const { claudeSessionId, toolName, toolInput, toolResponse, cwd } = input;

  // Validate required fields
  if (!claudeSessionId) {
    return {
      status: 400,
      body: { error: "claudeSessionId is required" },
    };
  }

  // Ensure session exists (create if not)
  const sessionResult = getSessionByClaudeId(deps.db, claudeSessionId);
  if (!sessionResult.ok) {
    return {
      status: 500,
      body: { error: sessionResult.error.message },
    };
  }

  const project = projectFromCwd(cwd);

  if (!sessionResult.value) {
    const createResult = createSession(deps.db, {
      claudeSessionId,
      project,
      userPrompt: "",
    });

    if (!createResult.ok) {
      return {
        status: 500,
        body: { error: createResult.error.message },
      };
    }
  }

  // Enqueue for background processing
  if (deps.router) {
    deps.router.enqueue({
      type: "observation",
      claudeSessionId,
      data: { toolName, toolInput, toolResponse, cwd },
    });
  }

  return {
    status: 200,
    body: {
      status: "queued",
      claudeSessionId,
      toolName,
    },
  };
};

/**
 * Queue a summary request.
 */
export const handleQueueSummary = async (
  deps: WorkerDeps,
  input: QueueSummaryInput,
): Promise<HandlerResponse> => {
  const { claudeSessionId, lastUserMessage, lastAssistantMessage } = input;

  // Validate session exists
  const sessionResult = getSessionByClaudeId(deps.db, claudeSessionId);
  if (!sessionResult.ok) {
    return {
      status: 500,
      body: { error: sessionResult.error.message },
    };
  }

  if (!sessionResult.value) {
    return {
      status: 404,
      body: { error: "Session not found" },
    };
  }

  // Enqueue for background processing
  if (deps.router) {
    deps.router.enqueue({
      type: "summarize",
      claudeSessionId,
      data: { lastUserMessage, lastAssistantMessage },
    });
  }

  return {
    status: 200,
    body: {
      status: "queued",
      claudeSessionId,
    },
  };
};

/**
 * Mark a session as completed.
 */
export const handleCompleteSession = async (
  deps: WorkerDeps,
  input: CompleteSessionInput,
): Promise<HandlerResponse> => {
  const { claudeSessionId, reason } = input;

  // Get session
  const sessionResult = getSessionByClaudeId(deps.db, claudeSessionId);
  if (!sessionResult.ok) {
    return {
      status: 500,
      body: { error: sessionResult.error.message },
    };
  }

  if (!sessionResult.value) {
    return {
      status: 404,
      body: { error: "Session not found" },
    };
  }

  // Enqueue completion for background processing
  if (deps.router) {
    deps.router.enqueue({
      type: "complete",
      claudeSessionId,
      data: { reason },
    });
  }

  return {
    status: 200,
    body: {
      status: "completed",
      claudeSessionId,
      reason,
    },
  };
};
