/**
 * Backfill CLI command — computes embeddings for observations that lack them.
 * Opens DB directly and iterates in batches.
 */

import { join } from "node:path";
import {
  createDatabase,
  getObservationsWithoutEmbeddings,
  runMigrations,
  updateObservationEmbedding,
} from "../db/index";
import { createModelManager } from "../models/manager";
import { buildEmbeddingText } from "../utils/embedding";

const BATCH_SIZE = 50;

const DB_PATH =
  process.env.CLAUDE_MEM_DB ||
  join(process.env.HOME || "", ".claude-mem", "memory.db");

const log = (msg: string) => console.log(`[backfill] ${msg}`);

export const main = async (): Promise<void> => {
  log(`Opening database: ${DB_PATH}`);
  const db = createDatabase(DB_PATH);
  runMigrations(db);

  const modelManager = createModelManager({});
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
  db.close();
};
