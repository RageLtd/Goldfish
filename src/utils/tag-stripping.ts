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
 * Strips <goldfish-context>...</goldfish-context> tags and their content from text.
 */
export const stripContextTags = (content: string): string =>
  content.replace(/<goldfish-context>[\s\S]*?<\/goldfish-context>/g, "");

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
 * Known low-signal patterns — affirmations, confirmations, and simple responses
 * that don't contain project-relevant information worth searching memory for.
 */
const LOW_SIGNAL_PATTERNS: ReadonlySet<string> = new Set([
  // Affirmations
  "yes",
  "no",
  "ok",
  "okay",
  "sure",
  "yep",
  "yup",
  "nope",
  "nah",
  "y",
  "n",
  "k",
  // Filler
  "hmm",
  "hm",
  "ah",
  "oh",
  "uh",
  "eh",
  "mhm",
  // Agreement
  "agreed",
  "correct",
  "right",
  "exactly",
  // Gratitude
  "thanks",
  "thank you",
  "ty",
  // Approval
  "lgtm",
  "looks good",
  "sounds good",
  "go ahead",
  "go for it",
  "do it",
  "let's do it",
  "lets do it",
  "proceed",
  "continue",
  "perfect",
  "great",
  "nice",
  "cool",
  "awesome",
  "got it",
  "understood",
  "makes sense",
  "fair enough",
  "good call",
  "ship it",
  "approve",
  "approved",
  // Short questions
  "what",
  "why",
  "how",
  "where",
  "when",
  "really",
  "seriously",
  // Acknowledgments
  "noted",
  "done",
  "fixed",
  "merged",
  "pushed",
  "committed",
  // Navigation
  "next",
  "back",
  "again",
  "more",
  "less",
]);

/**
 * Checks if a cleaned prompt is low-signal (simple affirmation/confirmation)
 * that doesn't warrant a memory retrieval search.
 *
 * Returns false for empty strings (those are handled by isEntirelyPrivate).
 */
export const isLowSignalPrompt = (cleaned: string): boolean => {
  const trimmed = cleaned.trim();
  if (trimmed.length === 0) return false;

  // Slash commands are skill invocations, not searchable queries
  if (trimmed.startsWith("/")) return true;

  // Normalize: lowercase, strip trailing punctuation
  const normalized = trimmed
    .toLowerCase()
    .replace(/[.!?,;:]+$/g, "")
    .trim();
  if (normalized.length === 0) return false;

  // Direct pattern match against known low-signal phrases
  if (LOW_SIGNAL_PATTERNS.has(normalized)) return true;

  // Code-like tokens bypass word-count check
  if (
    /[a-z][A-Z]/.test(trimmed) || // camelCase
    /^[A-Z][a-z]+[A-Z]/.test(trimmed) || // PascalCase
    trimmed.includes("_") || // snake_case
    trimmed.includes("`") || // backticks
    /\/\S/.test(trimmed) || // paths (slash followed by non-space)
    /\.\w/.test(trimmed) // file extensions / dotted names
  )
    return false;

  // Technical keywords (>4 chars, not in low-signal set) bypass word-count check
  const words = normalized.split(/\s+/);
  if (words.some((w) => !LOW_SIGNAL_PATTERNS.has(w) && w.length > 4))
    return false;

  // Short prompts below word threshold are low-signal
  const minWords = parseInt(process.env.GOLDFISH_MIN_PROMPT_WORDS || "3", 10);
  return words.length < minWords;
};

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
