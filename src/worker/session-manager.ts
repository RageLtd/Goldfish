/**
 * SessionManager - In-memory session state and message queues.
 * Manages active SDK sessions and provides async message iterators.
 * Includes TTL-based eviction to prevent memory leaks from abandoned sessions.
 */

import type { ToolObservation } from "../types/domain";

// ============================================================================
// Constants
// ============================================================================

/** Default session TTL: 1 hour of inactivity */
const DEFAULT_SESSION_TTL_MS = 60 * 60 * 1000;

/** Maximum number of active sessions before LRU eviction kicks in */
const MAX_ACTIVE_SESSIONS = 100;

/** How often to run eviction sweep (5 minutes) */
const EVICTION_INTERVAL_MS = 5 * 60 * 1000;

// ============================================================================
// Types
// ============================================================================

export interface ActiveSession {
	readonly sessionDbId: number;
	readonly claudeSessionId: string;
	readonly project: string;
	readonly userPrompt: string;
	readonly startedAt: number;
	readonly abortController: AbortController;
}

export type PendingMessageType = "observation" | "summarize" | "continuation";

export interface PendingMessage {
	readonly type: PendingMessageType;
	readonly data: ObservationMessage | SummarizeMessage | ContinuationMessage;
}

export interface ObservationMessage {
	readonly observation: ToolObservation;
}

export interface SummarizeMessage {
	readonly lastUserMessage: string;
	readonly lastAssistantMessage?: string;
}

export interface ContinuationMessage {
	readonly userPrompt: string;
	readonly promptNumber: number;
}

interface SessionState {
	readonly session: ActiveSession;
	readonly messageQueue: PendingMessage[];
	readonly waitingResolvers: Array<
		(value: IteratorResult<PendingMessage>) => void
	>;
	lastActivityAt: number;
	closed: boolean;
}

// ============================================================================
// SessionManager Interface
// ============================================================================

export interface SessionManager {
	readonly initializeSession: (
		sessionDbId: number,
		claudeSessionId: string,
		project: string,
		userPrompt: string,
	) => ActiveSession;
	readonly getSession: (sessionDbId: number) => ActiveSession | null;
	readonly queueObservation: (
		sessionDbId: number,
		observation: ToolObservation,
	) => boolean;
	readonly queueSummarize: (
		sessionDbId: number,
		lastUserMessage: string,
		lastAssistantMessage?: string,
	) => boolean;
	readonly queueContinuation: (
		sessionDbId: number,
		userPrompt: string,
		promptNumber: number,
	) => boolean;
	readonly getMessageIterator: (
		sessionDbId: number,
	) => AsyncIterableIterator<PendingMessage> | null;
	readonly closeSession: (sessionDbId: number) => boolean;
	readonly getActiveSessions: () => readonly ActiveSession[];
	/** Starts the periodic eviction sweep for idle/abandoned sessions */
	readonly startEvictionSweep: () => void;
	/** Stops the periodic eviction sweep */
	readonly stopEvictionSweep: () => void;
	/** Manually runs eviction (for testing) */
	readonly evictStaleSessions: () => number;
}

// ============================================================================
// Factory
// ============================================================================

export const createSessionManager = (): SessionManager => {
	const sessions = new Map<number, SessionState>();

	const initializeSession = (
		sessionDbId: number,
		claudeSessionId: string,
		project: string,
		userPrompt: string,
	): ActiveSession => {
		const existing = sessions.get(sessionDbId);
		if (existing) {
			return existing.session;
		}

		const session: ActiveSession = {
			sessionDbId,
			claudeSessionId,
			project,
			userPrompt,
			startedAt: Date.now(),
			abortController: new AbortController(),
		};

		const state: SessionState = {
			session,
			messageQueue: [],
			waitingResolvers: [],
			lastActivityAt: Date.now(),
			closed: false,
		};

		sessions.set(sessionDbId, state);
		return session;
	};

	const getSession = (sessionDbId: number): ActiveSession | null => {
		return sessions.get(sessionDbId)?.session ?? null;
	};

	const enqueueMessage = (
		sessionDbId: number,
		message: PendingMessage,
	): boolean => {
		const state = sessions.get(sessionDbId);
		if (!state || state.closed) {
			return false;
		}

		// Update last activity timestamp
		state.lastActivityAt = Date.now();

		const resolver = state.waitingResolvers.shift();
		if (resolver) {
			resolver({ value: message, done: false });
		} else {
			state.messageQueue.push(message);
		}

		return true;
	};

	const queueObservation = (
		sessionDbId: number,
		observation: ToolObservation,
	): boolean => {
		return enqueueMessage(sessionDbId, {
			type: "observation",
			data: { observation },
		});
	};

	const queueSummarize = (
		sessionDbId: number,
		lastUserMessage: string,
		lastAssistantMessage?: string,
	): boolean => {
		return enqueueMessage(sessionDbId, {
			type: "summarize",
			data: { lastUserMessage, lastAssistantMessage },
		});
	};

	const queueContinuation = (
		sessionDbId: number,
		userPrompt: string,
		promptNumber: number,
	): boolean => {
		return enqueueMessage(sessionDbId, {
			type: "continuation",
			data: { userPrompt, promptNumber },
		});
	};

	const getMessageIterator = (
		sessionDbId: number,
	): AsyncIterableIterator<PendingMessage> | null => {
		const state = sessions.get(sessionDbId);
		if (!state) {
			return null;
		}

		return {
			[Symbol.asyncIterator]() {
				return this;
			},

			next(): Promise<IteratorResult<PendingMessage>> {
				if (state.closed) {
					return Promise.resolve({ value: undefined, done: true });
				}

				const message = state.messageQueue.shift();
				if (message) {
					return Promise.resolve({ value: message, done: false });
				}

				return new Promise((resolve) => {
					state.waitingResolvers.push(resolve);
				});
			},

			return(): Promise<IteratorResult<PendingMessage>> {
				state.closed = true;
				for (const resolver of state.waitingResolvers) {
					resolver({ value: undefined, done: true });
				}
				state.waitingResolvers.length = 0;
				return Promise.resolve({ value: undefined, done: true });
			},
		};
	};

	const closeSession = (sessionDbId: number): boolean => {
		const state = sessions.get(sessionDbId);
		if (!state) {
			return false;
		}

		state.closed = true;
		state.session.abortController.abort();

		for (const resolver of state.waitingResolvers) {
			resolver({ value: undefined, done: true });
		}
		state.waitingResolvers.length = 0;

		sessions.delete(sessionDbId);
		return true;
	};

	const getActiveSessions = (): readonly ActiveSession[] => {
		return Array.from(sessions.values()).map((s) => s.session);
	};

	/**
	 * Evicts stale sessions based on TTL and max session limit.
	 * Returns the number of sessions evicted.
	 */
	const evictStaleSessions = (): number => {
		const now = Date.now();
		let evictedCount = 0;

		// First pass: evict sessions that have exceeded TTL
		for (const [sessionDbId, state] of sessions) {
			const idleTime = now - state.lastActivityAt;
			if (idleTime > DEFAULT_SESSION_TTL_MS) {
				closeSession(sessionDbId);
				evictedCount++;
			}
		}

		// Second pass: if still over limit, evict oldest (LRU)
		if (sessions.size > MAX_ACTIVE_SESSIONS) {
			const sortedByActivity = Array.from(sessions.entries()).sort(
				([, a], [, b]) => a.lastActivityAt - b.lastActivityAt,
			);

			const toEvict = sortedByActivity.slice(
				0,
				sessions.size - MAX_ACTIVE_SESSIONS,
			);
			for (const [sessionDbId] of toEvict) {
				closeSession(sessionDbId);
				evictedCount++;
			}
		}

		return evictedCount;
	};

	let evictionInterval: ReturnType<typeof setInterval> | null = null;

	const startEvictionSweep = (): void => {
		if (evictionInterval) {
			return; // Already running
		}
		evictionInterval = setInterval(() => {
			evictStaleSessions();
		}, EVICTION_INTERVAL_MS);
	};

	const stopEvictionSweep = (): void => {
		if (evictionInterval) {
			clearInterval(evictionInterval);
			evictionInterval = null;
		}
	};

	return {
		initializeSession,
		getSession,
		queueObservation,
		queueSummarize,
		queueContinuation,
		getMessageIterator,
		closeSession,
		getActiveSessions,
		startEvictionSweep,
		stopEvictionSweep,
		evictStaleSessions,
	};
};
