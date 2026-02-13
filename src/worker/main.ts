/**
 * Worker service entry point.
 * Starts an HTTP server that handles memory operations.
 */

import { join } from "node:path";
import pkg from "../../package.json";
import { createDatabase, runMigrations } from "../db/index";
import { fromPromise } from "../types/result";
import { ensureDbDir } from "../utils/fs";
import { createBackgroundProcessor } from "./background-processor";
import { createSDKAgent } from "./sdk-agent";
import { createWorkerRouter } from "./service";
import { createSessionManager } from "./session-manager";

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

      // Create session manager
      const sessionManager = createSessionManager();
      log("SessionManager initialized");

      // Create SDK agent (uses Claude Agent SDK with user's credentials)
      const sdkAgent = createSDKAgent({ db });
      log("SDKAgent initialized");

      // Create router with all dependencies
      const router = createWorkerRouter({
        db,
        sessionManager,
        startedAt,
        version: VERSION,
      });

      // Start HTTP server
      const server = Bun.serve({
        port: PORT,
        fetch: router.handle,
      });

      log(`Worker service running at http://127.0.0.1:${server.port}`);

      // Create background processor for SDK agent
      const backgroundProcessor = createBackgroundProcessor({
        sessionManager,
        sdkAgent,
        pollIntervalMs: 1000,
        onObservationStored: (sessionId, _observationId) => {
          log(`Observation stored for session ${sessionId}`);
        },
        onSummaryStored: (sessionId, _summaryId) => {
          log(`Summary stored for session ${sessionId}`);
        },
        onError: (sessionId, error) => {
          logError(`SDK error for session ${sessionId}: ${error}`);
        },
      });

      // Start background processing
      backgroundProcessor.start();
      log("BackgroundProcessor started");

      // Start session eviction sweep (prevents memory leaks from abandoned sessions)
      sessionManager.startEvictionSweep();
      log("Session eviction sweep started");

      // Handle shutdown
      const shutdown = async () => {
        log("Shutting down...");

        // Stop background processor and wait for active processing
        backgroundProcessor.stop();
        log(
          `Waiting for ${backgroundProcessor.getActiveProcessingCount()} active processing tasks...`,
        );
        await backgroundProcessor.awaitCompletion(5000);

        // Close all active sessions
        for (const session of sessionManager.getActiveSessions()) {
          sessionManager.closeSession(session.sessionDbId);
        }

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
