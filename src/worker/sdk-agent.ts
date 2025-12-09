/**
 * SDKAgent - Claude AI processing for observations.
 * Uses Claude to analyze tool executions and extract semantic meaning.
 */

import type { Database } from "bun:sqlite";
import { storeObservation, storeSummary } from "../db/index";
import { parseObservations, parseSummary } from "../sdk/parser";
import {
	buildContinuationPrompt,
	buildInitPrompt,
	buildObservationPrompt,
	buildSummaryPrompt,
} from "../sdk/prompts";
import type { ChromaSync } from "../services/chroma-sync";
import type { ToolObservation } from "../types/domain";
import type { ActiveSession } from "./session-manager";

// ============================================================================
// Types
// ============================================================================

export interface SDKAgentDeps {
	readonly db: Database;
	readonly anthropicApiKey: string;
	readonly queryFn?: QueryFunction;
	readonly chromaSync?: ChromaSync;
}

export type SDKAgentMessageType =
	| "observation_stored"
	| "summary_stored"
	| "aborted"
	| "error"
	| "acknowledged";

export interface SDKAgentMessage {
	readonly type: SDKAgentMessageType;
	readonly data?: unknown;
}

export interface SDKQueryMessage {
	readonly type: string;
	readonly content: string;
	readonly usage?: {
		readonly input_tokens?: number;
		readonly output_tokens?: number;
	};
}

export type QueryFunction = (
	prompt: AsyncIterable<{ type: string; message: string }>,
	options: { model: string; abortSignal?: AbortSignal },
) => AsyncIterable<SDKQueryMessage>;

export interface PendingInputMessage {
	readonly type: "observation" | "summarize" | "continuation";
	readonly data: {
		readonly observation?: ToolObservation;
		readonly lastUserMessage?: string;
		readonly lastAssistantMessage?: string;
		readonly userPrompt?: string;
		readonly promptNumber?: number;
	};
}

export interface SDKAgent {
	readonly processMessages: (
		session: ActiveSession,
		inputMessages: AsyncIterable<PendingInputMessage>,
	) => AsyncIterable<SDKAgentMessage>;
}

// ============================================================================
// Factory
// ============================================================================

export const createSDKAgent = (deps: SDKAgentDeps): SDKAgent => {
	const { db, queryFn, chromaSync } = deps;

	const processMessages = async function* (
		session: ActiveSession,
		inputMessages: AsyncIterable<PendingInputMessage>,
	): AsyncIterable<SDKAgentMessage> {
		// Check if already aborted
		if (session.abortController.signal.aborted) {
			yield { type: "aborted" };
			return;
		}

		let promptNumber = 1;
		let totalTokens = 0;

		// Build prompt generator for SDK
		async function* promptGenerator() {
			// Initial prompt
			yield {
				type: "user",
				message: buildInitPrompt({
					project: session.project,
					sessionId: session.claudeSessionId,
					userPrompt: session.userPrompt,
				}),
			};

			// Process incoming messages
			for await (const msg of inputMessages) {
				if (session.abortController.signal.aborted) {
					return;
				}

				if (msg.type === "observation" && msg.data.observation) {
					yield {
						type: "user",
						message: buildObservationPrompt(msg.data.observation),
					};
				} else if (msg.type === "summarize") {
					yield {
						type: "user",
						message: buildSummaryPrompt({
							lastUserMessage: msg.data.lastUserMessage || "",
							lastAssistantMessage: msg.data.lastAssistantMessage,
						}),
					};
				} else if (msg.type === "continuation" && msg.data.userPrompt) {
					promptNumber = msg.data.promptNumber || promptNumber + 1;
					yield {
						type: "user",
						message: buildContinuationPrompt({
							userPrompt: msg.data.userPrompt,
							promptNumber,
							sessionId: session.claudeSessionId,
						}),
					};
				}
			}
		}

		// If no queryFn provided, we can't process
		if (!queryFn) {
			yield { type: "error", data: "No query function provided" };
			return;
		}

		try {
			// Process SDK responses
			for await (const response of queryFn(promptGenerator(), {
				model: "claude-haiku-4-5",
				abortSignal: session.abortController.signal,
			})) {
				if (session.abortController.signal.aborted) {
					yield { type: "aborted" };
					return;
				}

				// Track tokens
				if (response.usage) {
					totalTokens +=
						(response.usage.input_tokens || 0) +
						(response.usage.output_tokens || 0);
				}

				if (response.type === "assistant" && response.content) {
					// Try to parse observations
					const observations = parseObservations(response.content);
					for (const obs of observations) {
						const result = storeObservation(db, {
							claudeSessionId: session.claudeSessionId,
							project: session.project,
							observation: obs,
							promptNumber,
							discoveryTokens: totalTokens,
						});

						if (result.ok) {
							// Sync to ChromaDB if available
							if (chromaSync) {
								await chromaSync.addObservation({
									id: result.value,
									sessionId: session.claudeSessionId,
									type: obs.type,
									title: obs.title,
									narrative: obs.narrative,
									concepts: obs.concepts,
									project: session.project,
								});
							}

							yield {
								type: "observation_stored",
								data: { id: result.value, observation: obs },
							};
						} else {
							// Report storage failure
							yield {
								type: "error",
								data: `Failed to store observation: ${result.error.message}`,
							};
						}
					}

					// Try to parse summary
					const summary = parseSummary(response.content);
					if (summary) {
						const result = storeSummary(db, {
							claudeSessionId: session.claudeSessionId,
							project: session.project,
							summary,
							promptNumber,
							discoveryTokens: totalTokens,
						});

						if (result.ok) {
							// Sync to ChromaDB if available
							if (chromaSync) {
								await chromaSync.addSummary({
									id: result.value,
									sessionId: session.claudeSessionId,
									request: summary.request,
									completed: summary.completed,
									learned: summary.learned,
									project: session.project,
								});
							}

							yield {
								type: "summary_stored",
								data: { id: result.value, summary },
							};
						} else {
							// Report storage failure
							yield {
								type: "error",
								data: `Failed to store summary: ${result.error.message}`,
							};
						}
					}

					// If no observation or summary, just acknowledge
					if (observations.length === 0 && !summary) {
						yield { type: "acknowledged" };
					}
				}
			}
		} catch (error) {
			if (session.abortController.signal.aborted) {
				yield { type: "aborted" };
			} else {
				yield {
					type: "error",
					data: error instanceof Error ? error.message : String(error),
				};
			}
		}
	};

	return { processMessages };
};
