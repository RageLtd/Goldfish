/**
 * Pure functions for hook business logic.
 * Hooks are thin wrappers that call these functions.
 */

import { basename } from "node:path";
import type {
	HookOutput,
	PostToolUseInput,
	SessionEndInput,
	SessionStartInput,
	StopInput,
	UserPromptSubmitInput,
} from "../types/hooks";
import { createContextOutput, createSuccessOutput } from "../types/hooks";
import {
	cleanPrompt,
	isEntirelyPrivate,
	stripPrivateTags,
} from "../utils/tag-stripping";

// ============================================================================
// Types
// ============================================================================

export interface HookDeps {
	readonly fetch: typeof fetch;
	readonly workerUrl: string;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Extracts project name from cwd path (cross-platform).
 */
const extractProject = (cwd?: string): string | null => {
	if (!cwd) return null;
	const name = basename(cwd);
	return name || null;
};

/**
 * Makes a POST request to the worker service.
 */
const postToWorker = async (
	deps: HookDeps,
	path: string,
	body: unknown,
): Promise<unknown> => {
	const response = await deps.fetch(`${deps.workerUrl}${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	return response.json();
};

/**
 * Makes a GET request to the worker service.
 */
const getFromWorker = async (
	deps: HookDeps,
	path: string,
	params: Record<string, string>,
): Promise<unknown> => {
	const url = new URL(`${deps.workerUrl}${path}`);
	for (const [key, value] of Object.entries(params)) {
		url.searchParams.set(key, value);
	}
	const response = await deps.fetch(url.toString());
	return response.json();
};

/**
 * Strips private tags from tool response if it's a string.
 */
const sanitizeToolResponse = (response: unknown): unknown => {
	if (typeof response === "string") {
		return stripPrivateTags(response);
	}
	return response;
};

// ============================================================================
// Hook Processors
// ============================================================================

/**
 * Processes SessionStart hook - fetches and injects context.
 */
export const processContextHook = async (
	deps: HookDeps,
	input: SessionStartInput,
): Promise<HookOutput> => {
	const project = extractProject(input.cwd);

	if (!project) {
		return createSuccessOutput();
	}

	try {
		const result = (await getFromWorker(deps, "/context", {
			project,
			limit: "20",
		})) as {
			context?: string;
			observationCount?: number;
			summaryCount?: number;
		};

		if (result.context?.trim()) {
			// Determine system message based on whether we have actual context
			const hasContext =
				(result.observationCount ?? 0) > 0 || (result.summaryCount ?? 0) > 0;
			const systemMessage = hasContext
				? "[claude-mem] Loaded context from previous sessions"
				: "[claude-mem] Starting fresh session (no previous context)";

			return createContextOutput(result.context, systemMessage);
		}

		return createSuccessOutput();
	} catch {
		// Don't block session start on errors
		return createSuccessOutput();
	}
};

/**
 * Processes PostToolUse hook - queues observation.
 */
export const processSaveHook = async (
	deps: HookDeps,
	input: PostToolUseInput,
): Promise<HookOutput> => {
	try {
		await postToWorker(deps, "/observation", {
			claudeSessionId: input.session_id,
			toolName: input.tool_name,
			toolInput: input.tool_input,
			toolResponse: sanitizeToolResponse(input.tool_response),
			cwd: input.cwd,
		});
	} catch {
		// Fire-and-forget: don't block Claude Code
	}

	return createSuccessOutput();
};

/**
 * Processes UserPromptSubmit hook - stores prompt.
 */
export const processNewHook = async (
	deps: HookDeps,
	input: UserPromptSubmitInput,
): Promise<HookOutput> => {
	// Skip entirely private prompts
	if (isEntirelyPrivate(input.prompt)) {
		return createSuccessOutput();
	}

	const cleanedPrompt = cleanPrompt(input.prompt);

	try {
		await postToWorker(deps, "/prompt", {
			claudeSessionId: input.session_id,
			prompt: cleanedPrompt,
			cwd: input.cwd,
		});
	} catch {
		// Fire-and-forget
	}

	return createSuccessOutput();
};

/**
 * Processes Stop hook - queues summary request.
 */
export const processSummaryHook = async (
	deps: HookDeps,
	input: StopInput,
): Promise<HookOutput> => {
	try {
		await postToWorker(deps, "/summary", {
			claudeSessionId: input.session_id,
			transcriptPath: input.transcript_path,
			lastUserMessage: "",
			lastAssistantMessage: "",
		});
	} catch {
		// Fire-and-forget
	}

	return createSuccessOutput();
};

/**
 * Processes SessionEnd hook - marks session completed.
 */
export const processCleanupHook = async (
	deps: HookDeps,
	input: SessionEndInput,
): Promise<HookOutput> => {
	try {
		await postToWorker(deps, "/complete", {
			claudeSessionId: input.session_id,
			reason: input.reason,
		});
	} catch {
		// Fire-and-forget
	}

	return createSuccessOutput();
};
