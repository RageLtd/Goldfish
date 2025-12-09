/**
 * MCP Server - Exposes search tools via Model Context Protocol.
 * Pure functional implementation for testability.
 */

import type { Database } from "bun:sqlite";
import {
	getRecentObservations,
	getRecentSummaries,
	searchObservations,
	searchSummaries,
} from "../db/index";

// ============================================================================
// Types
// ============================================================================

export interface MCPServerDeps {
	readonly db: Database;
	readonly workerUrl: string;
}

export interface MCPTool {
	readonly name: string;
	readonly description: string;
	readonly inputSchema: {
		readonly type: "object";
		readonly properties: Record<string, unknown>;
		readonly required?: readonly string[];
	};
}

export interface MCPToolRequest {
	readonly name: string;
	readonly arguments: Record<string, unknown>;
}

export interface MCPToolResult {
	readonly isError: boolean;
	readonly content: readonly { readonly type: "text"; readonly text: string }[];
}

export interface MCPServer {
	readonly listTools: () => Promise<readonly MCPTool[]>;
	readonly callTool: (request: MCPToolRequest) => Promise<MCPToolResult>;
}

// ============================================================================
// Tool Definitions
// ============================================================================

const TOOLS: readonly MCPTool[] = [
	{
		name: "search",
		description:
			"Search observations and summaries using full-text search. Returns relevant memories from past sessions.",
		inputSchema: {
			type: "object",
			properties: {
				query: {
					type: "string",
					description: "Search query string",
				},
				type: {
					type: "string",
					enum: ["observations", "summaries"],
					description: "Type of content to search",
				},
				project: {
					type: "string",
					description: "Filter by project name",
				},
				limit: {
					type: "number",
					description: "Maximum number of results",
				},
			},
			required: ["query"],
		},
	},
	{
		name: "timeline",
		description:
			"Get a chronological timeline of recent observations and summaries.",
		inputSchema: {
			type: "object",
			properties: {
				project: {
					type: "string",
					description: "Filter by project name",
				},
				limit: {
					type: "number",
					description: "Maximum number of items",
				},
			},
		},
	},
	{
		name: "decisions",
		description:
			"Get architectural and design decisions recorded during sessions.",
		inputSchema: {
			type: "object",
			properties: {
				project: {
					type: "string",
					description: "Filter by project name",
				},
				limit: {
					type: "number",
					description: "Maximum number of decisions",
				},
			},
		},
	},
	{
		name: "find_by_file",
		description: "Find observations related to a specific file path.",
		inputSchema: {
			type: "object",
			properties: {
				file: {
					type: "string",
					description: "File path to search for",
				},
				limit: {
					type: "number",
					description: "Maximum number of results",
				},
			},
			required: ["file"],
		},
	},
];

// ============================================================================
// Input Sanitization (Exported for unit testing security-critical logic)
// ============================================================================

/** @internal Maximum length for search queries. Exported for testing. */
export const MAX_QUERY_LENGTH = 500;
/** @internal Maximum length for general strings. Exported for testing. */
export const MAX_STRING_LENGTH = 1000;
/** @internal Default limit for paginated results. Exported for testing. */
export const DEFAULT_LIMIT = 10;
/** @internal Minimum allowed limit. Exported for testing. */
export const MIN_LIMIT = 1;
/** @internal Maximum allowed limit. Exported for testing. */
export const MAX_LIMIT = 100;

// biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally removing control chars
const CONTROL_CHARS_REGEX = /[\x00-\x08\x0B\x0C\x0E-\x1F]/g;

/**
 * Sanitizes a string input: trims, limits length, removes null bytes and control characters.
 * @internal Exported for security testing - use tool handlers for application logic.
 */
export const sanitizeString = (
	value: unknown,
	maxLength: number = MAX_STRING_LENGTH,
): string | undefined => {
	if (value === null || value === undefined) return undefined;
	if (typeof value !== "string") return undefined;
	// Remove null bytes and control characters, trim whitespace
	return value.replace(CONTROL_CHARS_REGEX, "").trim().slice(0, maxLength);
};

/**
 * Sanitizes a limit parameter: ensures it's a safe positive integer within bounds.
 * @internal Exported for security testing - use tool handlers for application logic.
 */
export const sanitizeLimit = (value: unknown): number => {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return DEFAULT_LIMIT;
	}
	const rounded = Math.floor(value);
	return Math.max(MIN_LIMIT, Math.min(MAX_LIMIT, rounded));
};

/**
 * Sanitizes a search query for FTS5: escapes special characters to prevent injection.
 * FTS5 special chars: AND, OR, NOT, *, ^, ", (, ), :, NEAR
 * @internal Exported for security testing - use tool handlers for application logic.
 */
export const sanitizeSearchQuery = (query: string): string => {
	// Wrap individual terms in quotes to treat them as literals
	// This prevents FTS5 syntax injection
	const sanitized = sanitizeString(query, MAX_QUERY_LENGTH);
	if (!sanitized) return "";
	// Escape double quotes and wrap in quotes for exact matching
	return `"${sanitized.replace(/"/g, '""')}"`;
};

// ============================================================================
// Tool Handlers
// ============================================================================

const handleSearch = (
	db: Database,
	args: Record<string, unknown>,
): MCPToolResult => {
	const rawQuery = sanitizeString(args.query, MAX_QUERY_LENGTH);
	if (!rawQuery) {
		return {
			isError: true,
			content: [{ type: "text", text: "Error: query is required" }],
		};
	}

	// Sanitize query for FTS5 to prevent syntax injection
	const query = sanitizeSearchQuery(rawQuery);
	const type = sanitizeString(args.type) || "observations";
	const project = sanitizeString(args.project);
	const limit = sanitizeLimit(args.limit);

	if (type === "observations") {
		const result = searchObservations(db, { query, project, limit });
		if (!result.ok) {
			return {
				isError: true,
				content: [{ type: "text", text: `Error: ${result.error.message}` }],
			};
		}

		const text = result.value
			.map(
				(o) =>
					`[${o.type}] ${o.title || "Untitled"}\n${o.narrative || o.subtitle || ""}`,
			)
			.join("\n\n");

		return {
			isError: false,
			content: [{ type: "text", text: text || "No results found" }],
		};
	}

	const result = searchSummaries(db, { query, project, limit });
	if (!result.ok) {
		return {
			isError: true,
			content: [{ type: "text", text: `Error: ${result.error.message}` }],
		};
	}

	const text = result.value
		.map((s) => `${s.request || "Untitled"}\n${s.completed || ""}`)
		.join("\n\n");

	return {
		isError: false,
		content: [{ type: "text", text: text || "No results found" }],
	};
};

const handleTimeline = (
	db: Database,
	args: Record<string, unknown>,
): MCPToolResult => {
	const project = sanitizeString(args.project);
	const limit = sanitizeLimit(args.limit);

	const obsResult = getRecentObservations(db, { project, limit });
	const sumResult = getRecentSummaries(db, { project, limit });

	if (!obsResult.ok) {
		return {
			isError: true,
			content: [{ type: "text", text: `Error: ${obsResult.error.message}` }],
		};
	}

	if (!sumResult.ok) {
		return {
			isError: true,
			content: [{ type: "text", text: `Error: ${sumResult.error.message}` }],
		};
	}

	// Merge and sort by epoch
	const items = [
		...obsResult.value.map((o) => ({
			epoch: o.createdAtEpoch,
			kind: "observation" as const,
			text: `[${o.type}] ${o.title || "Untitled"}`,
		})),
		...sumResult.value.map((s) => ({
			epoch: s.createdAtEpoch,
			kind: "summary" as const,
			text: `[summary] ${s.request || "Untitled"}`,
		})),
	]
		.sort((a, b) => b.epoch - a.epoch)
		.slice(0, limit);

	const text = items.map((i) => i.text).join("\n");

	return {
		isError: false,
		content: [{ type: "text", text: text || "No timeline items found" }],
	};
};

const handleDecisions = (
	db: Database,
	args: Record<string, unknown>,
): MCPToolResult => {
	const project = sanitizeString(args.project);
	const limit = sanitizeLimit(args.limit);

	// Get observations of type 'decision'
	const result = getRecentObservations(db, { project, limit: limit * 5 });
	if (!result.ok) {
		return {
			isError: true,
			content: [{ type: "text", text: `Error: ${result.error.message}` }],
		};
	}

	const decisions = result.value
		.filter((o) => o.type === "decision")
		.slice(0, limit);

	const text = decisions
		.map((d) => `${d.title || "Untitled"}\n${d.narrative || d.subtitle || ""}`)
		.join("\n\n");

	return {
		isError: false,
		content: [{ type: "text", text: text || "No decisions found" }],
	};
};

const handleFindByFile = (
	db: Database,
	args: Record<string, unknown>,
): MCPToolResult => {
	const file = sanitizeString(args.file);
	if (!file) {
		return {
			isError: true,
			content: [{ type: "text", text: "Error: file is required" }],
		};
	}

	const limit = sanitizeLimit(args.limit);

	// Search for file in observations (sanitize for FTS5)
	const query = sanitizeSearchQuery(file);
	const result = searchObservations(db, { query, limit });
	if (!result.ok) {
		return {
			isError: true,
			content: [{ type: "text", text: `Error: ${result.error.message}` }],
		};
	}

	// Filter to observations that actually reference this file
	const matching = result.value.filter(
		(o) =>
			o.filesRead.some((f) => f.includes(file)) ||
			o.filesModified.some((f) => f.includes(file)),
	);

	const text = matching
		.map(
			(o) =>
				`[${o.type}] ${o.title || "Untitled"}\nFiles: ${[...o.filesRead, ...o.filesModified].join(", ")}`,
		)
		.join("\n\n");

	return {
		isError: false,
		content: [{ type: "text", text: text || "No observations found for file" }],
	};
};

// ============================================================================
// Factory
// ============================================================================

export const createMCPServer = (deps: MCPServerDeps): MCPServer => {
	const { db } = deps;

	const listTools = async (): Promise<readonly MCPTool[]> => {
		return TOOLS;
	};

	const callTool = async (request: MCPToolRequest): Promise<MCPToolResult> => {
		const { name, arguments: args } = request;

		switch (name) {
			case "search":
				return handleSearch(db, args);
			case "timeline":
				return handleTimeline(db, args);
			case "decisions":
				return handleDecisions(db, args);
			case "find_by_file":
				return handleFindByFile(db, args);
			default:
				return {
					isError: true,
					content: [{ type: "text", text: `Unknown tool: ${name}` }],
				};
		}
	};

	return { listTools, callTool };
};
