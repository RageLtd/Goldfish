/**
 * Tests for MCP server main entry point.
 * Tests the stdio transport wrapper around the MCP server.
 */

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createDatabase, runMigrations } from "../../src/db/index";
import { createMCPServer } from "../../src/servers/mcp-server";

describe("MCP server main", () => {
	let db: Database;

	beforeEach(() => {
		db = createDatabase(":memory:");
		runMigrations(db);
	});

	afterEach(() => {
		db.close();
	});

	describe("createMCPServer integration", () => {
		it("creates server with proper configuration", () => {
			const server = createMCPServer({
				db,
				workerUrl: "http://localhost:3456",
			});

			expect(server).toBeDefined();
			expect(typeof server.listTools).toBe("function");
			expect(typeof server.callTool).toBe("function");
		});

		it("lists available tools", async () => {
			const server = createMCPServer({
				db,
				workerUrl: "http://localhost:3456",
			});

			const tools = await server.listTools();

			expect(tools.length).toBeGreaterThan(0);
			expect(tools.some((t) => t.name === "search")).toBe(true);
			expect(tools.some((t) => t.name === "timeline")).toBe(true);
			expect(tools.some((t) => t.name === "decisions")).toBe(true);
			expect(tools.some((t) => t.name === "find_by_file")).toBe(true);
		});

		it("handles tool calls", async () => {
			const server = createMCPServer({
				db,
				workerUrl: "http://localhost:3456",
			});

			const result = await server.callTool({
				name: "search",
				arguments: { query: "test", type: "observations" },
			});

			expect(result.isError).toBe(false);
			expect(result.content.length).toBeGreaterThan(0);
			expect(result.content[0].type).toBe("text");
		});

		it("returns error for unknown tool", async () => {
			const server = createMCPServer({
				db,
				workerUrl: "http://localhost:3456",
			});

			const result = await server.callTool({
				name: "unknown_tool",
				arguments: {},
			});

			expect(result.isError).toBe(true);
			expect(result.content[0].text).toContain("Unknown tool");
		});
	});
});
