/**
 * Worker service entry point.
 * Starts llama-server instances, then an HTTP server for memory operations.
 */

import pkg from "../../package.json";
import {
  DEFAULT_BINARY_DIR,
  DEFAULT_DB_PATH,
  DEFAULT_EMBED_MODEL_PATH,
  DEFAULT_EMBED_PORT,
  DEFAULT_GEN_MODEL_PATH,
  DEFAULT_GEN_PORT,
  DEFAULT_SERVER_TIMEOUT_MS,
  DEFAULT_WORKER_PORT,
} from "../constants";
import { createDatabase, runMigrations } from "../db/index";
import { createGraphManager } from "../graph/index";
import { ensureLlamaServer } from "../models/ensure-server";
import { createModelManager } from "../models/manager";
import {
  getOrStartServer,
  type ManagedServer,
  stopServer,
} from "../models/server-manager";
import { fromPromise } from "../types/result";
import { ensureDbDir } from "../utils/fs";
import { loadEmbeddingCache } from "./embedding-cache";
import { createMessageRouter, createProcessMessage } from "./message-router";
import { createWorkerRouter } from "./service";

// ============================================================================
// Configuration (env overrides)
// ============================================================================

const PORT = parseInt(
  process.env.GOLDFISH_PORT || String(DEFAULT_WORKER_PORT),
  10,
);
const DB_PATH = process.env.GOLDFISH_DB || DEFAULT_DB_PATH;
const VERSION = pkg.version;

const GEN_PORT = parseInt(
  process.env.GOLDFISH_LLAMA_GEN_PORT || String(DEFAULT_GEN_PORT),
  10,
);
const EMBED_PORT = parseInt(
  process.env.GOLDFISH_LLAMA_EMBED_PORT || String(DEFAULT_EMBED_PORT),
  10,
);
const SERVER_TIMEOUT = parseInt(
  process.env.GOLDFISH_LLAMA_SERVER_TIMEOUT ||
    String(DEFAULT_SERVER_TIMEOUT_MS),
  10,
);

const BINARY_DIR = process.env.GOLDFISH_LLAMA_CLI_PATH || DEFAULT_BINARY_DIR;
const GEN_MODEL =
  process.env.GOLDFISH_LLAMA_GENERATION_MODEL || DEFAULT_GEN_MODEL_PATH;
const EMBED_MODEL =
  process.env.GOLDFISH_LLAMA_EMBEDDING_MODEL || DEFAULT_EMBED_MODEL_PATH;

// ============================================================================
// Logging
// ============================================================================

const log = (message: string) => console.log(`[worker] ${message}`);
const logError = (message: string) =>
  console.error(`[worker] ERROR: ${message}`);

// ============================================================================
// Startup
// ============================================================================

const start = async (): Promise<void> => {
  const startedAt = Date.now();
  log(`Starting worker service on port ${PORT}`);
  log(`Database path: ${DB_PATH}`);

  const result = await fromPromise(
    (async () => {
      // 1. Ensure database directory exists and initialize
      await ensureDbDir(DB_PATH);
      const db = createDatabase(DB_PATH);
      runMigrations(db);
      log("Database initialized");

      // 2. Hydrate in-memory knowledge graph from SQLite
      const graphManager = createGraphManager();
      const hydrateResult = graphManager.hydrate(db);
      if (hydrateResult.ok) {
        log(`Knowledge graph hydrated (${hydrateResult.value} edges)`);
      } else {
        log(`Knowledge graph hydration failed: ${hydrateResult.error.message}`);
      }

      // 2b. Load embedding cache into memory (avoids per-query DB BLOB I/O)
      const cacheResult = loadEmbeddingCache(db);
      const embeddingCache = cacheResult.ok ? cacheResult.value : undefined;
      if (cacheResult.ok) {
        log(`Embedding cache loaded (${cacheResult.value.size} entries)`);
      } else {
        log(
          `Embedding cache load failed (will fall back to DB): ${cacheResult.error.message}`,
        );
      }

      // 3. Ensure llama-server binary is available (auto-download if missing)
      const ensureResult = await ensureLlamaServer(BINARY_DIR);
      if (!ensureResult.ok) throw ensureResult.error;

      log(
        `Acquiring llama-server instances (gen=:${GEN_PORT}, embed=:${EMBED_PORT})`,
      );

      const [genResult, embedResult] = await Promise.all([
        getOrStartServer(
          {
            binaryDir: BINARY_DIR,
            modelPath: GEN_MODEL,
            port: GEN_PORT,
            contextSize: 2048,
          },
          SERVER_TIMEOUT,
        ),
        getOrStartServer(
          {
            binaryDir: BINARY_DIR,
            modelPath: EMBED_MODEL,
            port: EMBED_PORT,
            contextSize: 512,
            embeddings: true,
          },
          SERVER_TIMEOUT,
        ),
      ]);

      if (!genResult.ok) throw genResult.error;
      if (!embedResult.ok) throw embedResult.error;

      const genServer = genResult.value;
      const embedServer = embedResult.value;

      log(
        `llama-server ready on port ${GEN_PORT} (generation, owned=${genServer.owned}) and ${EMBED_PORT} (embedding, owned=${embedServer.owned})`,
      );

      // 4. Create model manager with server URLs
      const modelManager = createModelManager({
        generationUrl: genServer.url,
        embeddingUrl: embedServer.url,
        generativeModelId: GEN_MODEL,
        embeddingModelId: EMBED_MODEL,
      });
      log(
        `ModelManager initialized (gen=${modelManager.getConfig().generativeModelId}, embed=${modelManager.getConfig().embeddingModelId})`,
      );

      // 5. Create message router (late-bind enqueue to break circular dep)
      let messageRouter: ReturnType<typeof createMessageRouter>;
      const processMessage = createProcessMessage({
        db,
        modelManager,
        graphManager,
        embeddingCache,
        enqueue: (msg) => messageRouter.enqueue(msg),
      });
      messageRouter = createMessageRouter({ processMessage });
      log("MessageRouter initialized");

      // Handle shutdown — stop owned llama-server processes before closing DB
      let server: ReturnType<typeof Bun.serve>;
      const shutdown = async () => {
        log("Shutting down...");
        log(`Draining ${messageRouter.pending()} pending messages...`);
        await messageRouter.shutdown();
        await modelManager.dispose();
        log("Stopping owned llama-server instances...");
        await cleanupServers(genServer, embedServer);
        db.close();
        server.stop();
        process.exit(0);
      };

      // 6. Create HTTP router (with shutdown callback for /shutdown endpoint)
      const httpRouter = createWorkerRouter({
        deps: {
          db,
          router: messageRouter,
          modelManager,
          graphManager,
          embeddingCache,
          startedAt,
          version: VERSION,
        },
        onShutdown: shutdown,
      });

      // 7. Start HTTP server
      server = Bun.serve({
        port: PORT,
        fetch: httpRouter.handle,
      });

      log(`Worker service running at http://127.0.0.1:${server.port}`);

      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    })(),
  );

  if (!result.ok) {
    logError(`Failed to start: ${result.error.message}`);
    process.exit(1);
  }
};

// ============================================================================
// Helpers
// ============================================================================

const cleanupServers = async (
  ...servers: readonly ManagedServer[]
): Promise<void> => {
  await Promise.allSettled(servers.map((s) => stopServer(s)));
};

export const main = start;

// Run directly if executed as script
if (import.meta.main) {
  main();
}
