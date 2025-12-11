/**
 * Pure functions for building prompts sent to the SDK agent.
 * The SDK agent is an OBSERVER - it records what happened, not what to do.
 */

import type { ToolObservation } from "../types/domain";

// ============================================================================
// Prompt Input Types
// ============================================================================

export interface InitPromptInput {
	readonly project: string;
	readonly sessionId: string;
	readonly userPrompt: string;
}

export interface SummaryPromptInput {
	readonly lastUserMessage: string;
	readonly lastAssistantMessage?: string;
}

export interface ContinuationPromptInput {
	readonly userPrompt: string;
	readonly promptNumber: number;
	readonly sessionId: string;
}

// ============================================================================
// Prompt Builders
// ============================================================================

/**
 * Builds the initial prompt that provides session context.
 * Note: The system prompt (observer role) is now handled via SDK options.
 */
export const buildInitPrompt = (input: InitPromptInput): string => {
	const { project, sessionId, userPrompt } = input;

	return `## Session Started

<session_context>
  <project>${project}</project>
  <session_id>${sessionId}</session_id>
  <user_request>${userPrompt}</user_request>
</session_context>

A new Claude Code session has started. I will send you tool execution notifications as they occur. Generate observations for meaningful work only.`;
};

/**
 * Builds a prompt for a tool observation from the primary session.
 */
export const buildObservationPrompt = (
	observation: ToolObservation,
): string => {
	const { toolName, toolInput, toolResponse, cwd, occurredAt } = observation;

	return `<observed_from_primary_session>
  <what_happened>${toolName}</what_happened>
  <occurred_at>${occurredAt}</occurred_at>
  <working_directory>${cwd}</working_directory>
  <parameters>${JSON.stringify(toolInput, null, 2)}</parameters>
  <outcome>${JSON.stringify(toolResponse, null, 2)}</outcome>
</observed_from_primary_session>

Analyze this tool execution. If it represents meaningful work (not routine operations), generate an observation. Otherwise, acknowledge and wait for more context.`;
};

/**
 * Builds a prompt requesting a session summary.
 */
export const buildSummaryPrompt = (input: SummaryPromptInput): string => {
	const { lastUserMessage, lastAssistantMessage } = input;

	return `## PROGRESS SUMMARY CHECKPOINT

The session is pausing. Generate a summary of what was accomplished.

<last_user_request>${lastUserMessage}</last_user_request>
${lastAssistantMessage ? `<last_assistant_response>${lastAssistantMessage}</last_assistant_response>` : ""}

Write a progress summary in this XML format:

<summary>
  <request>Short title: user's request AND substance of what was done</request>
  <investigated>What was explored? What was examined?</investigated>
  <learned>What was discovered about how things work?</learned>
  <completed>What work was completed? What shipped?</completed>
  <next_steps>What is the current trajectory of work?</next_steps>
  <notes>Additional insights or observations</notes>
</summary>

Focus on OUTCOMES and DELIVERABLES, not the process of recording them.`;
};

/**
 * Builds a continuation prompt for additional user messages in the same session.
 */
export const buildContinuationPrompt = (
	input: ContinuationPromptInput,
): string => {
	const { userPrompt, promptNumber, sessionId } = input;

	return `## CONTINUATION - Prompt #${promptNumber}

<session_id>${sessionId}</session_id>

The user has provided an additional request in this session:

<user_request>${userPrompt}</user_request>

Continue observing tool executions related to this follow-up request. Generate observations for meaningful work as before.`;
};
