/**
 * Worker service entry point.
 * Starts an HTTP server that handles memory operations.
 */

import { join } from "node:path";
import pkg from "../../package.json";
import { createDatabase, runMigrations } from "../db/index";
import { createModelManager } from "../models/manager";
import { fromPromise } from "../types/result";
import { ensureDbDir } from "../utils/fs";
import { createMessageRouter, createProcessMessage } from "./message-router";
import { createWorkerRouter } from "./service";

const PORT = parseInt(process.env.CLAUDE_MEM_PORT || "3456", 10);
const DB_PATH =
  process.env.CLAUDE_MEM_DB ||
  join(process.env.HOME || "", ".claude-mem", "memory.db");
const VERSION = pkg.version;

const log = (message: string) => console.log(`[worker] ${message}`);
const logError = (message: string) =>
  console.error(`[worker] ERROR: ${message}`);

/**
 * Starts the worker service.
 */
const start = async (): Promise<void> => {
  const startedAt = Date.now();
  log(`Starting worker service on port ${PORT}`);
  log(`Database path: ${DB_PATH}`);

  const result = await fromPromise(
    (async () => {
      // Ensure database directory exists
      await ensureDbDir(DB_PATH);

      // Initialize database
      const db = createDatabase(DB_PATH);
      runMigrations(db);
      log("Database initialized");

      // Create model manager
      const modelManager = createModelManager({});
      log(
        `ModelManager initialized (gen=${modelManager.getConfig().generativeModelId}, embed=${modelManager.getConfig().embeddingModelId})`,
      );

      // Create message router (replaces SessionManager + BackgroundProcessor)
      const processMessage = createProcessMessage({ db, modelManager });
      const messageRouter = createMessageRouter({ processMessage });
      log("MessageRouter initialized");

      // Create HTTP router with all dependencies
      const httpRouter = createWorkerRouter({
        db,
        router: messageRouter,
        modelManager,
        startedAt,
        version: VERSION,
      });

      // Start HTTP server
      const server = Bun.serve({
        port: PORT,
        fetch: httpRouter.handle,
      });

      log(`Worker service running at http://127.0.0.1:${server.port}`);

      // Handle shutdown
      const shutdown = async () => {
        log("Shutting down...");
        log(`Draining ${messageRouter.pending()} pending messages...`);
        await messageRouter.shutdown();
        await modelManager.dispose();
        db.close();
        server.stop();
        process.exit(0);
      };

      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    })(),
  );

  if (!result.ok) {
    logError(`Failed to start: ${result.error.message}`);
    process.exit(1);
  }
};

export const main = start;

// Run directly if executed as script
if (import.meta.main) {
  main();
}
