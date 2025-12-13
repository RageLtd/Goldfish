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
	readonly cwd?: string;
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

/**
 * System prompt for the memory observer agent.
 * This tells Claude its role as an observer that extracts and records observations.
 */
const SYSTEM_PROMPT = `You are Claude-Mem, a specialized **observer** tool that records what happens during a Claude Code session.

## Your Role

You are an OBSERVER, not an executor. You will receive notifications about tool executions from the primary Claude Code session. Your job is to:

1. **Record** what was LEARNED, DISCOVERED, BUILT, FIXED, INVESTIGATED, or DEBUGGED
2. **Extract** semantic meaning from tool executions
3. **Generate** structured observations in XML format

## What to Record

Record observations for:
- **Bug investigations**: Root cause analysis, debugging steps, what was found
- **Discoveries**: How code works, why something behaves a certain way
- **Fixes**: What was broken and how it was fixed
- **Features**: New functionality or capabilities added
- **Decisions**: Architectural choices, trade-offs considered
- **Understanding gained**: Insights about the codebase, patterns found

## What to Skip

Only skip truly trivial operations:
- Empty file checks that find nothing
- Basic package installs with no issues
- Simple file listings with no insights

## Critical Rules

- Record OUTCOMES and INSIGHTS, not just actions taken
- Use past tense verbs: discovered, investigated, found, fixed, implemented, learned
- Focus on WHAT was learned or accomplished
- When debugging: record what was investigated, what was found, and the conclusion
- Be generous about recording - it's better to record too much than too little

## Good Observations

- "Root cause: observations not stored because SDK agent classifies tool executions as routine"
- "Authentication now supports OAuth2 with PKCE flow"
- "Database connection pooling was exhausting connections due to missing cleanup"
- "Discovered that BackgroundProcessor polls every 1 second for active sessions"

## Bad Observations (DO NOT DO)

- "Analyzed authentication implementation and stored findings"
- "Tracked deployment steps and logged outcomes"
- "Recorded the changes made to the codebase"

## Output Format

When you observe something worth recording, output an observation in this XML format:

<observation>
  <type>[ bugfix | feature | refactor | change | discovery | decision ]</type>
  <title>Short title capturing the core action or topic</title>
  <subtitle>One sentence explanation (max 24 words)</subtitle>
  <facts>
    <fact>Concise, self-contained statement</fact>
    <fact>Another fact with specific details</fact>
  </facts>
  <narrative>Full context: What was done, how it works, why it matters</narrative>
  <concepts>
    <concept>how-it-works</concept>
    <concept>problem-solution</concept>
  </concepts>
  <files_read>
    <file>path/to/file.ts</file>
  </files_read>
  <files_modified>
    <file>path/to/modified.ts</file>
  </files_modified>
</observation>

## Observation Types

- **bugfix**: Something was broken, now fixed
- **feature**: New capability or functionality added
- **refactor**: Code restructured, behavior unchanged
- **change**: Generic modification (docs, config, misc)
- **discovery**: Learning about existing system, debugging insights, root cause analysis
- **decision**: Architectural/design choice with rationale

## Concept Tags

Use these to categorize observations:
- how-it-works: Understanding mechanisms
- why-it-exists: Purpose or rationale
- what-changed: Modifications made
- problem-solution: Issues and their fixes
- root-cause: Why something was broken
- gotcha: Traps or edge cases
- pattern: Reusable approach
- trade-off: Pros/cons of a decision
- debugging: Investigation and diagnosis

Wait for tool execution notifications before generating observations.`;

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

const log = (msg: string) => console.log(`[sdk-agent] ${msg}`);
const logError = (msg: string, err?: unknown) => {
	console.error(`[sdk-agent] ERROR: ${msg}`);
	if (err) {
		console.error(`[sdk-agent] Details:`, err);
	}
};

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

/**
 * Finds the Claude Code executable path.
 * Checks common installation locations using Bun-native APIs.
 */
const findClaudeExecutable = (): string | undefined => {
	const homeDir = process.env.HOME || "";

	// Check common locations
	const locations = [
		process.env.CLAUDE_CODE_PATH, // Explicit override
		`${homeDir}/.local/bin/claude`,
		`${homeDir}/.claude/local/claude`,
		"/usr/local/bin/claude",
	].filter(Boolean) as string[];

	for (const loc of locations) {
		try {
			// Use Bun.file to check if file exists
			const file = Bun.file(loc);
			if (file.size > 0) {
				return loc;
			}
		} catch {
			// File doesn't exist, continue
		}
	}

	return undefined;
};

export const createSDKAgent = (deps: SDKAgentDeps): SDKAgent => {
	const { db, chromaSync, model = "claude-haiku-4-5", cwd } = deps;
	const claudeExecutable = findClaudeExecutable();
	if (claudeExecutable) {
		log(`Found Claude executable at: ${claudeExecutable}`);
	} else {
		logError("Could not find Claude executable - SDK calls may fail");
	}

	const processMessages = async function* (
		session: ActiveSession,
		inputMessages: AsyncIterable<PendingInputMessage>,
	): AsyncIterable<SDKAgentMessage> {
		log(`Starting processMessages for session ${session.claudeSessionId}`);

		// Check if already aborted
		if (session.abortController.signal.aborted) {
			log("Session already aborted");
			yield { type: "aborted" };
			return;
		}

		let promptNumber = 1;
		let totalInputTokens = 0;
		let totalOutputTokens = 0;

		// Build prompt generator for SDK
		async function* promptGenerator(): AsyncGenerator<SDKUserMessage> {
			log("promptGenerator: yielding initial prompt");
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
			log("promptGenerator: waiting for input messages");
			for await (const msg of inputMessages) {
				log(`promptGenerator: received message type=${msg.type}`);
				if (session.abortController.signal.aborted) {
					log("promptGenerator: session aborted, returning");
					return;
				}

				if (msg.type === "observation" && msg.data.observation) {
					log(
						`promptGenerator: yielding observation for tool=${msg.data.observation.toolName}`,
					);
					yield createUserMessage(
						buildObservationPrompt(msg.data.observation),
						session.claudeSessionId,
					);
				} else if (msg.type === "summarize") {
					log("promptGenerator: yielding summarize request");
					yield createUserMessage(
						buildSummaryPrompt({
							lastUserMessage: msg.data.lastUserMessage || "",
							lastAssistantMessage: msg.data.lastAssistantMessage,
						}),
						session.claudeSessionId,
					);
				} else if (msg.type === "continuation" && msg.data.userPrompt) {
					promptNumber = msg.data.promptNumber || promptNumber + 1;
					log(`promptGenerator: yielding continuation prompt #${promptNumber}`);
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
			log("promptGenerator: input messages exhausted");
		}

		// Create the prompt generator instance
		const prompts = promptGenerator();

		log(`Calling SDK query with model=${model}, cwd=${cwd || process.cwd()}`);

		// Call the SDK query function - no try/catch, let errors propagate
		const queryResult = query({
			prompt: prompts,
			options: {
				model,
				systemPrompt: SYSTEM_PROMPT,
				tools: [], // Observer-only - no tools needed
				disallowedTools: DISALLOWED_TOOLS,
				permissionMode: "bypassPermissions",
				allowDangerouslySkipPermissions: true,
				cwd: cwd || process.cwd(),
				abortController: session.abortController,
				...(claudeExecutable && {
					pathToClaudeCodeExecutable: claudeExecutable,
				}),
			},
		});
		log("SDK query() called successfully, got async iterable");

		// Process SDK responses - no try/catch, let errors propagate
		log("Starting to iterate over SDK responses");
		let responseCount = 0;

		for await (const response of queryResult) {
			responseCount++;
			log(
				`Received SDK response #${responseCount}: type=${response.type}, subtype=${(response as { subtype?: string }).subtype || "n/a"}`,
			);

			if (session.abortController.signal.aborted) {
				log("Session aborted during processing");
				yield { type: "aborted" };
				return;
			}

			// Track tokens from result messages
			if (
				response.type === "result" &&
				(response as { subtype?: string }).subtype === "success"
			) {
				const usage = (
					response as {
						usage?: { input_tokens?: number; output_tokens?: number };
					}
				).usage;
				totalInputTokens += usage?.input_tokens || 0;
				totalOutputTokens += usage?.output_tokens || 0;
				log(
					`Token update: input=${totalInputTokens}, output=${totalOutputTokens}`,
				);
			}

			// Process assistant messages
			if (response.type === "assistant") {
				const content = extractAssistantText(response);
				if (!content) {
					log("Assistant message had no extractable text content");
					continue;
				}

				log(`Assistant content length: ${content.length} chars`);
				log(`Assistant content preview: ${content.substring(0, 200)}...`);

				const totalTokens = totalInputTokens + totalOutputTokens;

				// Try to parse observations
				const observations = parseObservations(content);
				log(`Parsed ${observations.length} observations from content`);

				for (const obs of observations) {
					log(`Storing observation: type=${obs.type}, title=${obs.title}`);
					const result = storeObservation(db, {
						claudeSessionId: session.claudeSessionId,
						project: session.project,
						observation: obs,
						promptNumber,
						discoveryTokens: totalTokens,
					});

					if (result.ok) {
						log(`Observation stored with id=${result.value}`);

						// Yield immediately - don't block on ChromaDB
						yield {
							type: "observation_stored",
							data: { id: result.value, observation: obs },
						};

						// Sync to ChromaDB asynchronously (fire-and-forget)
						if (chromaSync) {
							chromaSync
								.addObservation({
									id: result.value,
									sessionId: session.claudeSessionId,
									type: obs.type,
									title: obs.title,
									narrative: obs.narrative,
									concepts: obs.concepts,
									project: session.project,
								})
								.then((syncResult) => {
									if (syncResult.ok) {
										log("ChromaDB sync successful");
									} else {
										logError(
											`ChromaDB sync failed: ${syncResult.error.message}`,
										);
									}
								})
								.catch((e) => {
									logError("ChromaDB sync error", e);
								});
						}
					} else {
						logError(`Failed to store observation: ${result.error.message}`);
						yield {
							type: "error",
							data: `Failed to store observation: ${result.error.message}`,
						};
					}
				}

				// Try to parse summary
				const summary = parseSummary(content);
				if (summary) {
					log(
						`Storing summary: request=${summary.request?.substring(0, 50)}...`,
					);
					const result = storeSummary(db, {
						claudeSessionId: session.claudeSessionId,
						project: session.project,
						summary,
						promptNumber,
						discoveryTokens: totalTokens,
					});

					if (result.ok) {
						log(`Summary stored with id=${result.value}`);

						// Yield immediately - don't block on ChromaDB
						yield {
							type: "summary_stored",
							data: { id: result.value, summary },
						};

						// Sync to ChromaDB asynchronously (fire-and-forget)
						if (chromaSync) {
							chromaSync
								.addSummary({
									id: result.value,
									sessionId: session.claudeSessionId,
									request: summary.request,
									completed: summary.completed,
									learned: summary.learned,
									project: session.project,
								})
								.then((syncResult) => {
									if (syncResult.ok) {
										log("ChromaDB summary sync successful");
									} else {
										logError(
											`ChromaDB summary sync failed: ${syncResult.error.message}`,
										);
									}
								})
								.catch((e) => {
									logError("ChromaDB summary sync error", e);
								});
						}
					} else {
						logError(`Failed to store summary: ${result.error.message}`);
						yield {
							type: "error",
							data: `Failed to store summary: ${result.error.message}`,
						};
					}
				}

				// If no observation or summary, just acknowledge
				if (observations.length === 0 && !summary) {
					log("No observations or summary parsed, acknowledging");
					yield { type: "acknowledged" };
				}
			}
		}

		log(`processMessages complete. Processed ${responseCount} SDK responses.`);
	};

	return { processMessages };
};
