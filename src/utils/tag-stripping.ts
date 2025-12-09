/**
 * Pure functions for stripping memory-related tags from content.
 * These tags are used for privacy and context injection.
 */

/**
 * Strips <private>...</private> tags and their content from text.
 * Uses a stack to track nesting depth - content only included when stack is empty.
 */
export const stripPrivateTags = (content: string): string => {
	const result: string[] = [];
	let stack = 0;
	let i = 0;

	while (i < content.length) {
		if (content.startsWith("<private>", i)) {
			stack++;
			i += 9;
		} else if (content.startsWith("</private>", i)) {
			if (stack > 0) stack--;
			i += 10;
		} else {
			if (stack === 0) result.push(content[i]);
			i++;
		}
	}

	return result.join("");
};

/**
 * Strips <claude-mem-context>...</claude-mem-context> tags and their content from text.
 */
export const stripContextTags = (content: string): string =>
	content.replace(/<claude-mem-context>[\s\S]*?<\/claude-mem-context>/g, "");

/**
 * Strips <system-reminder>...</system-reminder> tags and their content from text.
 */
export const stripSystemReminders = (content: string): string =>
	content.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "");

/**
 * Strips all memory-related tags (private, context) without trimming.
 * Preserves whitespace as-is.
 */
export const stripAllMemoryTags = (content: string): string =>
	stripContextTags(stripPrivateTags(content));

/**
 * Cleans a prompt by stripping tags, trimming, and normalizing whitespace.
 * Use this for user prompts before storage.
 */
export const cleanPrompt = (content: string): string =>
	stripAllMemoryTags(content).trim();

/**
 * Checks if content is entirely private (nothing remains after stripping and trimming).
 */
export const isEntirelyPrivate = (content: string): boolean =>
	cleanPrompt(content).length === 0;

/**
 * Strips memory tags from a JSON string, handling edge cases.
 * Returns '{}' for non-string or invalid inputs.
 */
export const stripMemoryTagsFromJson = (content: unknown): string => {
	if (typeof content !== "string") {
		return "{}";
	}
	return cleanPrompt(content) || "{}";
};
