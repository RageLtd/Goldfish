/**
 * SessionManager - In-memory session state and message queues.
 * Manages active SDK sessions and provides async message iterators.
 */

import type { ToolObservation } from "../types/domain";

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

	return {
		initializeSession,
		getSession,
		queueObservation,
		queueSummarize,
		queueContinuation,
		getMessageIterator,
		closeSession,
		getActiveSessions,
	};
};
