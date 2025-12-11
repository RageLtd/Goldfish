/**
 * Temporal utilities for parsing time-based query parameters.
 */

// ============================================================================
// Constants
// ============================================================================

const MS_PER_DAY = 86400000;
const MS_PER_WEEK = MS_PER_DAY * 7;

// ============================================================================
// Time Parsing
// ============================================================================

/**
 * Parses a "since" parameter into an epoch timestamp.
 *
 * Supported formats:
 * - "today" - Start of today
 * - "yesterday" - Start of yesterday
 * - "Nd" - N days ago (e.g., "7d" for 7 days)
 * - "Nw" - N weeks ago (e.g., "2w" for 2 weeks)
 * - ISO date string (e.g., "2024-01-15")
 * - Epoch timestamp (number as string)
 *
 * Returns null for invalid input.
 */
export const parseSince = (since: string | undefined): number | null => {
	if (!since || typeof since !== "string") {
		return null;
	}

	const trimmed = since.trim().toLowerCase();

	// Handle special keywords
	if (trimmed === "today") {
		return getStartOfDay(new Date());
	}

	if (trimmed === "yesterday") {
		return getStartOfDay(new Date()) - MS_PER_DAY;
	}

	// Handle relative days (e.g., "7d")
	const daysMatch = trimmed.match(/^(\d+)d$/);
	if (daysMatch) {
		const days = parseInt(daysMatch[1], 10);
		if (days > 0 && days <= 365) {
			return Date.now() - days * MS_PER_DAY;
		}
		return null;
	}

	// Handle relative weeks (e.g., "2w")
	const weeksMatch = trimmed.match(/^(\d+)w$/);
	if (weeksMatch) {
		const weeks = parseInt(weeksMatch[1], 10);
		if (weeks > 0 && weeks <= 52) {
			return Date.now() - weeks * MS_PER_WEEK;
		}
		return null;
	}

	// Handle epoch timestamp
	const epochMatch = trimmed.match(/^\d{10,13}$/);
	if (epochMatch) {
		const epoch = parseInt(trimmed, 10);
		// Normalize to milliseconds if seconds
		return epoch < 10000000000 ? epoch * 1000 : epoch;
	}

	// Handle ISO date string
	const isoDate = new Date(since);
	if (!Number.isNaN(isoDate.getTime())) {
		return isoDate.getTime();
	}

	return null;
};

/**
 * Gets the start of day (midnight) for a given date.
 */
export const getStartOfDay = (date: Date): number => {
	const d = new Date(date);
	d.setHours(0, 0, 0, 0);
	return d.getTime();
};

/**
 * Gets the start of the current week (Sunday).
 */
export const getStartOfWeek = (date: Date): number => {
	const d = new Date(date);
	d.setHours(0, 0, 0, 0);
	d.setDate(d.getDate() - d.getDay());
	return d.getTime();
};

// ============================================================================
// Date Labels
// ============================================================================

/**
 * Gets a human-readable label for a timestamp relative to now.
 */
export const getRelativeLabel = (epoch: number): string => {
	const now = Date.now();
	const today = getStartOfDay(new Date());
	const yesterday = today - MS_PER_DAY;
	const weekAgo = today - MS_PER_WEEK;

	if (epoch >= today) {
		return "Today";
	}
	if (epoch >= yesterday) {
		return "Yesterday";
	}
	if (epoch >= weekAgo) {
		return "This Week";
	}
	return "Older";
};

/**
 * Formats an epoch timestamp as a date string.
 */
export const formatDate = (epoch: number): string => {
	return new Date(epoch).toLocaleDateString("en-US", {
		month: "short",
		day: "numeric",
		year: "numeric",
	});
};

/**
 * Formats an epoch timestamp as a time string.
 */
export const formatTime = (epoch: number): string => {
	return new Date(epoch).toLocaleTimeString("en-US", {
		hour: "numeric",
		minute: "2-digit",
		hour12: true,
	});
};

/**
 * Formats an epoch timestamp as date and time.
 */
export const formatDateTime = (epoch: number): string => {
	return new Date(epoch).toLocaleString("en-US", {
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
		hour12: true,
	});
};
