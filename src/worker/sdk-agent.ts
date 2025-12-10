/**
 * SDKAgent - Claude AI processing for observations.
 * Uses the Claude Agent SDK to analyze tool executions and extract semantic meaning.
 */

import type { Database } from "bun:sqlite";
import {
	query,
	type SDKMessage,
	type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
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
	readonly chromaSync?: ChromaSync;
	readonly model?: string;
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

// All tools are disallowed - the memory agent is observer-only
const DISALLOWED_TOOLS = [
	"Bash",
	"Edit",
	"MultiEdit",
	"Write",
	"WebFetch",
	"WebSearch",
	"TodoRead",
	"TodoWrite",
	"Task",
	"Glob",
	"Grep",
	"LS",
	"Read",
	"NotebookEdit",
];

/**
 * Creates an SDKUserMessage from a text prompt.
 */
const createUserMessage = (
	text: string,
	sessionId: string,
): SDKUserMessage => ({
	type: "user",
	message: {
		role: "user",
		content: text,
	},
	parent_tool_use_id: null,
	session_id: sessionId,
});

/**
 * Extracts text content from an assistant message.
 */
const extractAssistantText = (message: SDKMessage): string | null => {
	if (message.type !== "assistant") return null;

	const content = message.message?.content;
	if (!content) return null;

	if (typeof content === "string") return content;

	if (Array.isArray(content)) {
		return content
			.filter(
				(block): block is { type: "text"; text: string } =>
					typeof block === "object" && block !== null && block.type === "text",
			)
			.map((block) => block.text)
			.join("\n");
	}

	return null;
};

// ============================================================================
// Factory
// ============================================================================

export const createSDKAgent = (deps: SDKAgentDeps): SDKAgent => {
	const { db, chromaSync, model = "claude-haiku-4-5" } = deps;

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
		let totalInputTokens = 0;
		let totalOutputTokens = 0;

		// Build prompt generator for SDK
		async function* promptGenerator(): AsyncGenerator<SDKUserMessage> {
			// Initial prompt
			yield createUserMessage(
				buildInitPrompt({
					project: session.project,
					sessionId: session.claudeSessionId,
					userPrompt: session.userPrompt,
				}),
				session.claudeSessionId,
			);

			// Process incoming messages
			for await (const msg of inputMessages) {
				if (session.abortController.signal.aborted) {
					return;
				}

				if (msg.type === "observation" && msg.data.observation) {
					yield createUserMessage(
						buildObservationPrompt(msg.data.observation),
						session.claudeSessionId,
					);
				} else if (msg.type === "summarize") {
					yield createUserMessage(
						buildSummaryPrompt({
							lastUserMessage: msg.data.lastUserMessage || "",
							lastAssistantMessage: msg.data.lastAssistantMessage,
						}),
						session.claudeSessionId,
					);
				} else if (msg.type === "continuation" && msg.data.userPrompt) {
					promptNumber = msg.data.promptNumber || promptNumber + 1;
					yield createUserMessage(
						buildContinuationPrompt({
							userPrompt: msg.data.userPrompt,
							promptNumber,
							sessionId: session.claudeSessionId,
						}),
						session.claudeSessionId,
					);
				}
			}
		}

		try {
			// Use the Agent SDK query function
			const queryResult = query({
				prompt: promptGenerator(),
				options: {
					model,
					disallowedTools: DISALLOWED_TOOLS,
					abortController: session.abortController,
				},
			});

			// Process SDK responses
			for await (const response of queryResult) {
				if (session.abortController.signal.aborted) {
					yield { type: "aborted" };
					return;
				}

				// Track tokens from result messages
				if (response.type === "result" && response.subtype === "success") {
					totalInputTokens += response.usage?.input_tokens || 0;
					totalOutputTokens += response.usage?.output_tokens || 0;
				}

				// Process assistant messages
				if (response.type === "assistant") {
					const content = extractAssistantText(response);
					if (!content) continue;

					const totalTokens = totalInputTokens + totalOutputTokens;

					// Try to parse observations
					const observations = parseObservations(content);
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
							yield {
								type: "error",
								data: `Failed to store observation: ${result.error.message}`,
							};
						}
					}

					// Try to parse summary
					const summary = parseSummary(content);
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
