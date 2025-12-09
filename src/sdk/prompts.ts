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
 * Builds the initial prompt that sets up the SDK agent as an observer.
 */
export const buildInitPrompt = (input: InitPromptInput): string => {
	const { project, sessionId, userPrompt } = input;

	return `You are Claude-Mem, a specialized **observer** tool that records what happens during a Claude Code session.

<session_context>
  <project>${project}</project>
  <session_id>${sessionId}</session_id>
  <user_request>${userPrompt}</user_request>
</session_context>

## Your Role

You are an OBSERVER, not an executor. You will receive notifications about tool executions from the primary Claude Code session. Your job is to:

1. **Record** what was LEARNED, BUILT, FIXED, DEPLOYED, or CONFIGURED
2. **Extract** semantic meaning from tool executions
3. **Generate** structured observations in XML format

## Critical Rules

- Record OUTCOMES and DELIVERABLES, not actions taken
- Use past tense verbs: implemented, fixed, deployed, configured, migrated, optimized
- Focus on WHAT was accomplished, not HOW you're recording it
- Skip routine operations (empty file checks, package installs, file listings)

## Good Observations

- "Authentication now supports OAuth2 with PKCE flow"
- "Database schema migrated to use UUID primary keys"
- "Build pipeline includes automated security scanning"

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
- **discovery**: Learning about existing system
- **decision**: Architectural/design choice with rationale

## Concept Tags

Use these to categorize observations:
- how-it-works: Understanding mechanisms
- why-it-exists: Purpose or rationale
- what-changed: Modifications made
- problem-solution: Issues and their fixes
- gotcha: Traps or edge cases
- pattern: Reusable approach
- trade-off: Pros/cons of a decision

Wait for tool execution notifications before generating observations.`;
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
