/**
 * Types for Claude Code hook inputs and outputs.
 * These match the Claude Code hook system contract.
 */

// ============================================================================
// Hook Input Types (from Claude Code stdin)
// ============================================================================

export interface SessionStartInput {
	readonly session_id?: string;
	readonly transcript_path?: string;
	readonly cwd?: string;
	readonly source?: "startup" | "resume" | "clear" | "compact";
}

export interface UserPromptSubmitInput {
	readonly session_id: string;
	readonly cwd: string;
	readonly prompt: string;
}

export interface PostToolUseInput {
	readonly session_id: string;
	readonly cwd: string;
	readonly tool_name: string;
	readonly tool_input: unknown;
	readonly tool_response: unknown;
}

export interface StopInput {
	readonly session_id: string;
	readonly cwd: string;
	readonly transcript_path?: string;
}

export interface SessionEndInput {
	readonly session_id: string;
	readonly cwd: string;
	readonly transcript_path?: string;
	readonly hook_event_name: string;
	readonly reason: "exit" | "clear" | "logout" | "prompt_input_exit" | "other";
}

// ============================================================================
// Hook Output Types (to Claude Code stdout)
// ============================================================================

export interface HookOutput {
	readonly continue: boolean;
	readonly suppressOutput?: boolean;
	readonly hookSpecificOutput?: {
		readonly hookEventName?: string;
		readonly additionalContext?: string;
		readonly error?: string;
	};
}

// ============================================================================
// Hook Response Builders
// ============================================================================

export const createSuccessOutput = (suppressOutput = true): HookOutput => ({
	continue: true,
	suppressOutput,
});

export const createContextOutput = (context: string): HookOutput => ({
	continue: true,
	hookSpecificOutput: {
		hookEventName: "SessionStart",
		additionalContext: context,
	},
});

export const createErrorOutput = (
	hookName: string,
	error: string,
): HookOutput => ({
	continue: true,
	suppressOutput: false,
	hookSpecificOutput: {
		error: `[${hookName}] ${error}`,
	},
});
