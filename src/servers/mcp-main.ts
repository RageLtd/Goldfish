/**
 * MCP Server entry point.
 * Exposes memory search tools via Model Context Protocol over stdio.
 */

import { join } from "node:path";
import pkg from "../../package.json";
import { createDatabase, runMigrations } from "../db/index";
import { ensureDbDir } from "../utils/fs";
import { createMCPServer } from "./mcp-server";

const DB_PATH =
	process.env.CLAUDE_MEM_DB ||
	join(process.env.HOME || "", ".claude-mem", "memory.db");
const WORKER_URL = process.env.CLAUDE_MEM_WORKER_URL || "http://localhost:3456";

const log = (message: string) => console.error(`[mcp] ${message}`);

/**
 * Handles MCP protocol messages over stdio.
 * This is a simplified implementation - in production, use the official MCP SDK.
 */
interface MCPMessage {
	readonly jsonrpc: "2.0";
	readonly id?: number | string;
	readonly method?: string;
	readonly params?: unknown;
	readonly result?: unknown;
	readonly error?: { code: number; message: string };
}

const sendResponse = (id: number | string | undefined, result: unknown) => {
	const response: MCPMessage = {
		jsonrpc: "2.0",
		id,
		result,
	};
	console.log(JSON.stringify(response));
};

const sendError = (
	id: number | string | undefined,
	code: number,
	message: string,
) => {
	const response: MCPMessage = {
		jsonrpc: "2.0",
		id,
		error: { code, message },
	};
	console.log(JSON.stringify(response));
};

/**
 * Starts the MCP server.
 */
const start = async (): Promise<void> => {
	log(`Starting MCP server`);
	log(`Database path: ${DB_PATH}`);
	log(`Worker URL: ${WORKER_URL}`);

	try {
		// Ensure database directory exists
		await ensureDbDir(DB_PATH);

		// Initialize database
		const db = createDatabase(DB_PATH);
		runMigrations(db);
		log("Database initialized");

		// Create MCP server
		const server = createMCPServer({ db, workerUrl: WORKER_URL });
		log("MCP server created");

		// Read stdin line by line
		const decoder = new TextDecoder();
		let buffer = "";

		for await (const chunk of Bun.stdin.stream()) {
			buffer += decoder.decode(chunk);

			// Process complete JSON-RPC messages (newline-delimited)
			for (
				let newlineIndex = buffer.indexOf("\n");
				newlineIndex !== -1;
				newlineIndex = buffer.indexOf("\n")
			) {
				const line = buffer.slice(0, newlineIndex);
				buffer = buffer.slice(newlineIndex + 1);

				if (!line.trim()) continue;

				try {
					const message = JSON.parse(line) as MCPMessage;
					await handleMessage(server, message);
				} catch (e) {
					log(`Parse error: ${e}`);
					sendError(undefined, -32700, "Parse error");
				}
			}
		}
	} catch (e) {
		log(`Failed to start: ${e}`);
		process.exit(1);
	}
};

/**
 * Handles a single MCP message.
 */
const handleMessage = async (
	server: ReturnType<typeof createMCPServer>,
	message: MCPMessage,
): Promise<void> => {
	const { id, method, params } = message;

	switch (method) {
		case "initialize": {
			sendResponse(id, {
				protocolVersion: "2024-11-05",
				capabilities: {
					tools: {},
				},
				serverInfo: {
					name: "claude-mem",
					version: pkg.version,
				},
			});
			break;
		}

		case "initialized": {
			// Client acknowledged initialization
			break;
		}

		case "tools/list": {
			const tools = await server.listTools();
			sendResponse(id, { tools });
			break;
		}

		case "tools/call": {
			const toolParams = params as {
				name: string;
				arguments?: Record<string, unknown>;
			};
			const result = await server.callTool({
				name: toolParams.name,
				arguments: toolParams.arguments || {},
			});
			sendResponse(id, result);
			break;
		}

		case "ping": {
			sendResponse(id, {});
			break;
		}

		default: {
			if (method) {
				sendError(id, -32601, `Method not found: ${method}`);
			}
		}
	}
};

export const main = start;

// Run directly if executed as script
if (import.meta.main) {
	main();
}
