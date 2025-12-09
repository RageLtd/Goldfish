/**
 * Tests for MCP Server - search tools exposed via MCP protocol.
 * Tests are written first following TDD principles.
 */

import type { Database } from "bun:sqlite";
import { describe, expect, it, mock } from "bun:test";
import {
	createMCPServer,
	DEFAULT_LIMIT,
	MAX_LIMIT,
	MAX_QUERY_LENGTH,
	MAX_STRING_LENGTH,
	type MCPServerDeps,
	type MCPToolRequest,
	MIN_LIMIT,
	sanitizeLimit,
	sanitizeSearchQuery,
	sanitizeString,
} from "../../src/servers/mcp-server";

// ============================================================================
// Test Helpers
// ============================================================================

const createMockDb = (): Database => {
	return {
		run: mock(() => ({ lastInsertRowid: 1, changes: 1 })),
		query: mock(() => ({
			get: mock(() => null),
			all: mock(() => []),
		})),
	} as unknown as Database;
};

// ============================================================================
// Tests
// ============================================================================

describe("MCP Server", () => {
	describe("createMCPServer", () => {
		it("creates a server with required methods", () => {
			const deps: MCPServerDeps = {
				db: createMockDb(),
				workerUrl: "http://localhost:3456",
			};

			const server = createMCPServer(deps);

			expect(server.listTools).toBeDefined();
			expect(server.callTool).toBeDefined();
		});
	});

	describe("listTools", () => {
		it("returns list of available tools", async () => {
			const deps: MCPServerDeps = {
				db: createMockDb(),
				workerUrl: "http://localhost:3456",
			};

			const server = createMCPServer(deps);
			const tools = await server.listTools();

			expect(Array.isArray(tools)).toBe(true);
			expect(tools.length).toBeGreaterThan(0);

			// Should have search tool
			expect(tools.some((t) => t.name === "search")).toBe(true);
		});

		it("includes tool schemas", async () => {
			const deps: MCPServerDeps = {
				db: createMockDb(),
				workerUrl: "http://localhost:3456",
			};

			const server = createMCPServer(deps);
			const tools = await server.listTools();

			const searchTool = tools.find((t) => t.name === "search");
			expect(searchTool).toBeDefined();
			expect(searchTool?.inputSchema).toBeDefined();
			expect(searchTool?.description).toBeDefined();
		});

		it("includes timeline tool", async () => {
			const deps: MCPServerDeps = {
				db: createMockDb(),
				workerUrl: "http://localhost:3456",
			};

			const server = createMCPServer(deps);
			const tools = await server.listTools();

			expect(tools.some((t) => t.name === "timeline")).toBe(true);
		});

		it("includes decisions tool", async () => {
			const deps: MCPServerDeps = {
				db: createMockDb(),
				workerUrl: "http://localhost:3456",
			};

			const server = createMCPServer(deps);
			const tools = await server.listTools();

			expect(tools.some((t) => t.name === "decisions")).toBe(true);
		});

		it("includes find_by_file tool", async () => {
			const deps: MCPServerDeps = {
				db: createMockDb(),
				workerUrl: "http://localhost:3456",
			};

			const server = createMCPServer(deps);
			const tools = await server.listTools();

			expect(tools.some((t) => t.name === "find_by_file")).toBe(true);
		});
	});

	describe("callTool", () => {
		it("returns error for unknown tool", async () => {
			const deps: MCPServerDeps = {
				db: createMockDb(),
				workerUrl: "http://localhost:3456",
			};

			const server = createMCPServer(deps);
			const request: MCPToolRequest = {
				name: "unknown_tool",
				arguments: {},
			};

			const result = await server.callTool(request);

			expect(result.isError).toBe(true);
			expect(result.content[0].text).toContain("Unknown tool");
		});

		it("calls search tool with query", async () => {
			const mockDb = createMockDb();
			mockDb.query = mock(() => ({
				get: mock(() => null),
				all: mock(() => [
					{
						id: 1,
						sdk_session_id: "session-1",
						project: "test",
						type: "feature",
						title: "Test feature",
						subtitle: null,
						narrative: "Test narrative",
						facts: "[]",
						concepts: "[]",
						files_read: "[]",
						files_modified: "[]",
						prompt_number: 1,
						discovery_tokens: 100,
						created_at: "2024-01-01T00:00:00Z",
						created_at_epoch: 1704067200000,
						rank: 1,
					},
				]),
			}));

			const deps: MCPServerDeps = {
				db: mockDb,
				workerUrl: "http://localhost:3456",
			};

			const server = createMCPServer(deps);
			const request: MCPToolRequest = {
				name: "search",
				arguments: { query: "test", type: "observations", limit: 10 },
			};

			const result = await server.callTool(request);

			expect(result.isError).toBe(false);
			expect(result.content[0].text).toContain("Test feature");
		});

		it("calls timeline tool", async () => {
			const mockDb = createMockDb();
			mockDb.query = mock(() => ({
				get: mock(() => null),
				all: mock(() => []),
			}));

			const deps: MCPServerDeps = {
				db: mockDb,
				workerUrl: "http://localhost:3456",
			};

			const server = createMCPServer(deps);
			const request: MCPToolRequest = {
				name: "timeline",
				arguments: { limit: 10 },
			};

			const result = await server.callTool(request);

			expect(result.isError).toBe(false);
		});

		it("calls decisions tool", async () => {
			const mockDb = createMockDb();
			mockDb.query = mock(() => ({
				get: mock(() => null),
				all: mock(() => []),
			}));

			const deps: MCPServerDeps = {
				db: mockDb,
				workerUrl: "http://localhost:3456",
			};

			const server = createMCPServer(deps);
			const request: MCPToolRequest = {
				name: "decisions",
				arguments: { limit: 10 },
			};

			const result = await server.callTool(request);

			expect(result.isError).toBe(false);
		});

		it("calls find_by_file tool", async () => {
			const mockDb = createMockDb();
			mockDb.query = mock(() => ({
				get: mock(() => null),
				all: mock(() => []),
			}));

			const deps: MCPServerDeps = {
				db: mockDb,
				workerUrl: "http://localhost:3456",
			};

			const server = createMCPServer(deps);
			const request: MCPToolRequest = {
				name: "find_by_file",
				arguments: { file: "src/index.ts", limit: 10 },
			};

			const result = await server.callTool(request);

			expect(result.isError).toBe(false);
		});

		it("validates required arguments", async () => {
			const deps: MCPServerDeps = {
				db: createMockDb(),
				workerUrl: "http://localhost:3456",
			};

			const server = createMCPServer(deps);
			const request: MCPToolRequest = {
				name: "search",
				arguments: {}, // Missing required 'query'
			};

			const result = await server.callTool(request);

			expect(result.isError).toBe(true);
			expect(result.content[0].text).toContain("required");
		});
	});

	describe("sanitizeString", () => {
		it("returns undefined for null", () => {
			expect(sanitizeString(null)).toBeUndefined();
		});

		it("returns undefined for undefined", () => {
			expect(sanitizeString(undefined)).toBeUndefined();
		});

		it("returns undefined for non-string types", () => {
			expect(sanitizeString(123)).toBeUndefined();
			expect(sanitizeString({})).toBeUndefined();
			expect(sanitizeString([])).toBeUndefined();
			expect(sanitizeString(true)).toBeUndefined();
		});

		it("trims whitespace", () => {
			expect(sanitizeString("  hello  ")).toBe("hello");
			expect(sanitizeString("\t\ntest\r\n")).toBe("test");
		});

		it("removes null bytes", () => {
			expect(sanitizeString("hello\x00world")).toBe("helloworld");
		});

		it("removes control characters", () => {
			expect(sanitizeString("hello\x01\x02\x03world")).toBe("helloworld");
			expect(sanitizeString("\x00\x08\x0B\x0C\x0E\x1Ftest")).toBe("test");
		});

		it("preserves newlines and tabs in valid positions", () => {
			// Newline (0x0A) and carriage return (0x0D) are NOT in the control char regex
			// But they get trimmed by .trim()
			expect(sanitizeString("line1\nline2")).toBe("line1\nline2");
		});

		it("truncates to max length", () => {
			const longString = "a".repeat(2000);
			expect(sanitizeString(longString)?.length).toBe(MAX_STRING_LENGTH);
		});

		it("respects custom max length", () => {
			const result = sanitizeString("hello world", 5);
			expect(result).toBe("hello");
		});

		it("handles empty string", () => {
			expect(sanitizeString("")).toBe("");
		});

		it("handles string with only whitespace", () => {
			expect(sanitizeString("   ")).toBe("");
		});
	});

	describe("sanitizeLimit", () => {
		it("returns default for non-number", () => {
			expect(sanitizeLimit("10")).toBe(DEFAULT_LIMIT);
			expect(sanitizeLimit(null)).toBe(DEFAULT_LIMIT);
			expect(sanitizeLimit(undefined)).toBe(DEFAULT_LIMIT);
			expect(sanitizeLimit({})).toBe(DEFAULT_LIMIT);
		});

		it("returns default for NaN", () => {
			expect(sanitizeLimit(Number.NaN)).toBe(DEFAULT_LIMIT);
		});

		it("returns default for Infinity", () => {
			expect(sanitizeLimit(Number.POSITIVE_INFINITY)).toBe(DEFAULT_LIMIT);
			expect(sanitizeLimit(Number.NEGATIVE_INFINITY)).toBe(DEFAULT_LIMIT);
		});

		it("clamps to MIN_LIMIT", () => {
			expect(sanitizeLimit(0)).toBe(MIN_LIMIT);
			expect(sanitizeLimit(-5)).toBe(MIN_LIMIT);
			expect(sanitizeLimit(-100)).toBe(MIN_LIMIT);
		});

		it("clamps to MAX_LIMIT", () => {
			expect(sanitizeLimit(200)).toBe(MAX_LIMIT);
			expect(sanitizeLimit(1000)).toBe(MAX_LIMIT);
		});

		it("floors decimal values", () => {
			expect(sanitizeLimit(5.9)).toBe(5);
			expect(sanitizeLimit(10.1)).toBe(10);
		});

		it("returns valid numbers within range", () => {
			expect(sanitizeLimit(1)).toBe(1);
			expect(sanitizeLimit(50)).toBe(50);
			expect(sanitizeLimit(100)).toBe(100);
		});
	});

	describe("sanitizeSearchQuery", () => {
		it("wraps query in quotes", () => {
			expect(sanitizeSearchQuery("test")).toBe('"test"');
		});

		it("escapes double quotes", () => {
			expect(sanitizeSearchQuery('test "quoted"')).toBe('"test ""quoted"""');
		});

		it("returns empty string for empty input", () => {
			expect(sanitizeSearchQuery("")).toBe("");
		});

		it("returns empty string for whitespace-only input", () => {
			expect(sanitizeSearchQuery("   ")).toBe("");
		});

		it("sanitizes control characters before quoting", () => {
			expect(sanitizeSearchQuery("test\x00query")).toBe('"testquery"');
		});

		it("truncates to MAX_QUERY_LENGTH", () => {
			const longQuery = "a".repeat(1000);
			const result = sanitizeSearchQuery(longQuery);
			// Result should be quoted, so length is MAX_QUERY_LENGTH + 2 for quotes
			expect(result.length).toBe(MAX_QUERY_LENGTH + 2);
		});

		it("prevents FTS5 syntax injection with AND", () => {
			// By wrapping in quotes, FTS5 treats this as a literal string
			expect(sanitizeSearchQuery("test AND secret")).toBe('"test AND secret"');
		});

		it("prevents FTS5 syntax injection with OR", () => {
			expect(sanitizeSearchQuery("test OR admin")).toBe('"test OR admin"');
		});

		it("prevents FTS5 syntax injection with NOT", () => {
			expect(sanitizeSearchQuery("test NOT allowed")).toBe(
				'"test NOT allowed"',
			);
		});

		it("prevents FTS5 syntax injection with wildcards", () => {
			expect(sanitizeSearchQuery("test*")).toBe('"test*"');
			expect(sanitizeSearchQuery("^test")).toBe('"^test"');
		});

		it("prevents FTS5 syntax injection with NEAR", () => {
			expect(sanitizeSearchQuery("test NEAR secret")).toBe(
				'"test NEAR secret"',
			);
		});

		it("handles parentheses as literals", () => {
			expect(sanitizeSearchQuery("(test)")).toBe('"(test)"');
		});

		it("handles colons as literals", () => {
			expect(sanitizeSearchQuery("column:value")).toBe('"column:value"');
		});
	});
});
