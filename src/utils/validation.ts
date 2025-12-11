/**
 * Input validation utilities.
 * Shared validation functions for HTTP handlers.
 */

// ============================================================================
// Constants
// ============================================================================

export const MIN_LIMIT = 1;
export const MAX_LIMIT = 100;
export const DEFAULT_LIMIT = 10;

export const MAX_PROJECT_LENGTH = 100;
export const PROJECT_PATTERN = /^[a-zA-Z0-9_-]+$/;

// ============================================================================
// Validation Functions
// ============================================================================

/**
 * Sanitizes a limit parameter: ensures it's a safe positive integer within bounds.
 * Returns DEFAULT_LIMIT for invalid values.
 */
export const sanitizeLimit = (value: unknown): number => {
	if (typeof value === "string") {
		const parsed = parseInt(value, 10);
		if (Number.isNaN(parsed)) {
			return DEFAULT_LIMIT;
		}
		return Math.max(MIN_LIMIT, Math.min(MAX_LIMIT, Math.floor(parsed)));
	}

	if (typeof value !== "number" || !Number.isFinite(value)) {
		return DEFAULT_LIMIT;
	}

	const rounded = Math.floor(value);
	return Math.max(MIN_LIMIT, Math.min(MAX_LIMIT, rounded));
};

/**
 * Sanitizes a project name to prevent path traversal and injection.
 * Returns "unknown" for invalid values.
 */
export const sanitizeProject = (value: unknown): string => {
	if (typeof value !== "string" || !value.trim()) {
		return "unknown";
	}

	const trimmed = value.trim();

	// Check length
	if (trimmed.length > MAX_PROJECT_LENGTH) {
		return "unknown";
	}

	// Check pattern - only allow safe characters
	if (!PROJECT_PATTERN.test(trimmed)) {
		return "unknown";
	}

	return trimmed;
};

/**
 * Extracts and sanitizes project name from a cwd path.
 * Uses basename and validates the result.
 */
export const projectFromCwd = (cwd: string): string => {
	if (!cwd || typeof cwd !== "string") {
		return "unknown";
	}

	// Extract basename (last path component)
	const parts = cwd.split(/[/\\]/);
	const basename = parts[parts.length - 1] || "";

	return sanitizeProject(basename);
};

/**
 * Escapes a string for FTS5 phrase search by wrapping in double quotes
 * and escaping any internal double quotes.
 * This prevents FTS5 query syntax errors from special characters
 * like *, ^, (, ), AND, OR, NOT, and : by treating the input as a literal phrase.
 */
export const escapeFts5Query = (query: string): string => {
	if (!query || typeof query !== "string") {
		return '""';
	}
	// Escape internal double quotes and wrap in quotes for phrase search
	return `"${query.replace(/"/g, '""')}"`;
};
