/**
 * HTTP handlers for the worker service.
 * Pure functions that take dependencies and input, return response objects.
 */

import type { Database } from "bun:sqlite";
import { basename } from "node:path";
import {
	createSession,
	getRecentObservations,
	getRecentSummaries,
	getSessionByClaudeId,
	incrementPromptCounter,
	saveUserPrompt,
	searchObservations,
	searchSummaries,
	updateSessionStatus,
} from "../db/index";
import type { SessionManager } from "./session-manager";

// ============================================================================
// Types
// ============================================================================

export interface WorkerDeps {
	readonly db: Database;
	readonly sessionManager?: SessionManager;
	readonly startedAt?: number;
	readonly version?: string;
}

export interface HandlerResponse<T = unknown> {
	readonly status: number;
	readonly body: T;
}

// Input types for handlers
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
}

export interface CompleteSessionInput {
	readonly claudeSessionId: string;
	readonly reason: string;
}

export interface GetContextInput {
	readonly project: string;
	readonly limit: number;
}

export interface SearchInput {
	readonly query: string;
	readonly type: "observations" | "summaries";
	readonly project?: string;
	readonly limit: number;
}

export interface QueuePromptInput {
	readonly claudeSessionId: string;
	readonly prompt: string;
	readonly cwd: string;
}

// ============================================================================
// Handlers
// ============================================================================

export interface HealthCheckResponse {
	readonly status: string;
	readonly version: string;
	readonly uptimeSeconds: number;
	readonly activeSessions: number;
}

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
	const activeSessions = deps.sessionManager?.getActiveSessions().length ?? 0;

	return {
		status: 200,
		body: {
			status: "ok",
			version: deps.version || "unknown",
			uptimeSeconds,
			activeSessions,
		},
	};
};

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

	let sessionId: number;

	if (!sessionResult.value) {
		// Create session with minimal info
		const createResult = createSession(deps.db, {
			claudeSessionId,
			project: cwd || "unknown",
			userPrompt: "",
		});

		if (!createResult.ok) {
			return {
				status: 500,
				body: { error: createResult.error.message },
			};
		}
		sessionId = createResult.value.id;
	} else {
		sessionId = sessionResult.value.id;
	}

	// Queue observation in SessionManager if available
	if (deps.sessionManager) {
		deps.sessionManager.queueObservation(sessionId, {
			toolName,
			toolInput,
			toolResponse,
			cwd,
			occurredAt: new Date().toISOString(),
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
 * Queue a user prompt for processing.
 */
export const handleQueuePrompt = async (
	deps: WorkerDeps,
	input: QueuePromptInput,
): Promise<HandlerResponse> => {
	const { claudeSessionId, prompt, cwd } = input;

	// Validate required fields
	if (!claudeSessionId || !prompt) {
		return {
			status: 400,
			body: { error: "claudeSessionId and prompt are required" },
		};
	}

	// Get or create session
	const sessionResult = getSessionByClaudeId(deps.db, claudeSessionId);
	if (!sessionResult.ok) {
		return {
			status: 500,
			body: { error: sessionResult.error.message },
		};
	}

	let sessionId: number;
	let promptNumber: number;
	const project = basename(cwd) || "unknown";

	if (!sessionResult.value) {
		// Try to create new session (handles race condition via INSERT OR IGNORE)
		const createResult = createSession(deps.db, {
			claudeSessionId,
			project,
			userPrompt: prompt,
		});

		if (!createResult.ok) {
			return {
				status: 500,
				body: { error: createResult.error.message },
			};
		}

		sessionId = createResult.value.id;

		// Use isNew to determine if this is truly a new session or we lost a race
		if (createResult.value.isNew) {
			promptNumber = 1;

			// Initialize in SessionManager if available
			if (deps.sessionManager) {
				deps.sessionManager.initializeSession(
					sessionId,
					claudeSessionId,
					project,
					prompt,
				);
			}
		} else {
			// Lost the race - session was created by another request
			// Treat as continuation
			const counterResult = incrementPromptCounter(deps.db, sessionId);
			if (!counterResult.ok) {
				return {
					status: 500,
					body: { error: counterResult.error.message },
				};
			}
			promptNumber = counterResult.value;

			// Queue continuation in SessionManager if available
			if (deps.sessionManager) {
				deps.sessionManager.queueContinuation(sessionId, prompt, promptNumber);
			}
		}
	} else {
		sessionId = sessionResult.value.id;

		// Increment counter for continuation prompt
		const counterResult = incrementPromptCounter(deps.db, sessionId);
		if (!counterResult.ok) {
			return {
				status: 500,
				body: { error: counterResult.error.message },
			};
		}
		promptNumber = counterResult.value;

		// Queue continuation in SessionManager if available
		if (deps.sessionManager) {
			deps.sessionManager.queueContinuation(sessionId, prompt, promptNumber);
		}
	}

	// Store the prompt
	const saveResult = saveUserPrompt(deps.db, {
		claudeSessionId,
		promptNumber,
		promptText: prompt,
	});

	if (!saveResult.ok) {
		return {
			status: 500,
			body: { error: saveResult.error.message },
		};
	}

	return {
		status: 200,
		body: {
			status: "stored",
			claudeSessionId,
			promptNumber,
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

	// Queue summarize in SessionManager if available
	if (deps.sessionManager) {
		deps.sessionManager.queueSummarize(
			sessionResult.value.id,
			lastUserMessage,
			lastAssistantMessage,
		);
	}

	// Queue summary request
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

	// Close session in SessionManager if available
	if (deps.sessionManager) {
		deps.sessionManager.closeSession(sessionResult.value.id);
	}

	// Update status
	const updateResult = updateSessionStatus(
		deps.db,
		sessionResult.value.id,
		"completed",
	);

	if (!updateResult.ok) {
		return {
			status: 500,
			body: { error: updateResult.error.message },
		};
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

/**
 * Get context for a project (recent observations and summaries).
 */
export const handleGetContext = async (
	deps: WorkerDeps,
	input: GetContextInput,
): Promise<HandlerResponse> => {
	const { project, limit } = input;

	// Get recent observations
	const observationsResult = getRecentObservations(deps.db, { project, limit });
	if (!observationsResult.ok) {
		return {
			status: 500,
			body: { error: observationsResult.error.message },
		};
	}

	// Get recent summaries
	const summariesResult = getRecentSummaries(deps.db, { project, limit });
	if (!summariesResult.ok) {
		return {
			status: 500,
			body: { error: summariesResult.error.message },
		};
	}

	// Format context as string
	const observations = observationsResult.value;
	const summaries = summariesResult.value;

	const contextParts: string[] = [];

	if (summaries.length > 0) {
		contextParts.push("## Recent Session Summaries\n");
		for (const s of summaries) {
			if (s.request) contextParts.push(`- Request: ${s.request}`);
			if (s.completed) contextParts.push(`  Completed: ${s.completed}`);
			if (s.learned) contextParts.push(`  Learned: ${s.learned}`);
		}
	}

	if (observations.length > 0) {
		contextParts.push("\n## Recent Observations\n");
		for (const o of observations) {
			if (o.title) contextParts.push(`- [${o.type}] ${o.title}`);
			if (o.narrative) contextParts.push(`  ${o.narrative}`);
		}
	}

	return {
		status: 200,
		body: {
			context: contextParts.join("\n"),
			observationCount: observations.length,
			summaryCount: summaries.length,
		},
	};
};

/**
 * Search observations or summaries.
 */
export const handleSearch = async (
	deps: WorkerDeps,
	input: SearchInput,
): Promise<HandlerResponse> => {
	const { query, type, project, limit } = input;

	// Validate type
	if (type !== "observations" && type !== "summaries") {
		return {
			status: 400,
			body: {
				error: `Invalid type: ${type}. Must be 'observations' or 'summaries'`,
			},
		};
	}

	if (type === "observations") {
		const result = searchObservations(deps.db, { query, project, limit });
		if (!result.ok) {
			return {
				status: 500,
				body: { error: result.error.message },
			};
		}

		return {
			status: 200,
			body: {
				results: result.value,
				count: result.value.length,
			},
		};
	}

	// type === 'summaries'
	const result = searchSummaries(deps.db, { query, project, limit });
	if (!result.ok) {
		return {
			status: 500,
			body: { error: result.error.message },
		};
	}

	return {
		status: 200,
		body: {
			results: result.value,
			count: result.value.length,
		},
	};
};
