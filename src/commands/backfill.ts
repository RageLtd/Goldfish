/**
 * Backfill CLI command — computes embeddings for observations that lack them.
 * Opens DB directly, starts an embedding server, and iterates in batches.
 */

import {
  DEFAULT_BINARY_DIR,
  DEFAULT_DB_PATH,
  DEFAULT_EMBED_MODEL_PATH,
  DEFAULT_EMBED_PORT,
  DEFAULT_GEN_PORT,
  DEFAULT_SERVER_TIMEOUT_MS,
  serverUrl,
} from "../constants";
import {
  createDatabase,
  getObservationsWithoutEmbeddings,
  runMigrations,
  updateObservationEmbedding,
} from "../db/index";
import { ensureLlamaServer } from "../models/ensure-server";
import { createModelManager } from "../models/manager";
import { getOrStartServer, stopServer } from "../models/server-manager";
import { buildEmbeddingText } from "../utils/embedding";

const BATCH_SIZE = 50;

const DB_PATH = process.env.CLAUDE_MEM_DB || DEFAULT_DB_PATH;
const BINARY_DIR = process.env.CLAUDE_MEM_LLAMA_CLI_PATH || DEFAULT_BINARY_DIR;
const EMBED_PORT = parseInt(
  process.env.CLAUDE_MEM_LLAMA_EMBED_PORT || String(DEFAULT_EMBED_PORT),
  10,
);
const SERVER_TIMEOUT = parseInt(
  process.env.CLAUDE_MEM_LLAMA_SERVER_TIMEOUT ||
    String(DEFAULT_SERVER_TIMEOUT_MS),
  10,
);

const log = (msg: string) => console.log(`[backfill] ${msg}`);

export const main = async (): Promise<void> => {
  log(`Opening database: ${DB_PATH}`);
  const db = createDatabase(DB_PATH);
  runMigrations(db);

  // Ensure llama-server binary is available (auto-download if missing)
  const ensureResult = await ensureLlamaServer(BINARY_DIR);
  if (!ensureResult.ok) {
    log(`Failed to ensure llama-server: ${ensureResult.error.message}`);
    db.close();
    return;
  }

  // Get or start embedding server (reuses worker's if running)
  const embedModelPath =
    process.env.CLAUDE_MEM_LLAMA_EMBEDDING_MODEL || DEFAULT_EMBED_MODEL_PATH;

  const serverResult = await getOrStartServer(
    {
      binaryDir: BINARY_DIR,
      modelPath: embedModelPath,
      port: EMBED_PORT,
      contextSize: 512,
      embeddings: true,
    },
    SERVER_TIMEOUT,
  );

  if (!serverResult.ok) {
    log(`Failed to acquire embedding server: ${serverResult.error.message}`);
    db.close();
    return;
  }

  const embedServer = serverResult.value;
  log(`Embedding server on port ${EMBED_PORT} (owned=${embedServer.owned})`);

  const modelManager = createModelManager({
    generationUrl: serverUrl(DEFAULT_GEN_PORT), // Not used for backfill
    embeddingUrl: embedServer.url,
  });
  log(`Using embedding model: ${modelManager.getConfig().embeddingModelId}`);

  let totalProcessed = 0;

  // Process in batches
  for (;;) {
    const batchResult = getObservationsWithoutEmbeddings(db, {
      limit: BATCH_SIZE,
    });

    if (!batchResult.ok) {
      log(`Error fetching observations: ${batchResult.error.message}`);
      break;
    }

    const batch = batchResult.value;
    if (batch.length === 0) break;

    for (const obs of batch) {
      const text = buildEmbeddingText(obs);
      const embedding = await modelManager.computeEmbedding(text);
      const storeResult = updateObservationEmbedding(db, obs.id, embedding);

      if (!storeResult.ok) {
        log(
          `Failed to store embedding for #${obs.id}: ${storeResult.error.message}`,
        );
        continue;
      }

      totalProcessed++;
    }

    log(`Processed ${totalProcessed} observations so far...`);
  }

  log(`Backfill complete: ${totalProcessed} embeddings computed`);
  await modelManager.dispose();
  await stopServer(embedServer);
  db.close();
};
