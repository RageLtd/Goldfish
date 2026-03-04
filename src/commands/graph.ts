/**
 * Graph backfill CLI command — creates edges for observations that have
 * embeddings but were stored before the knowledge graph was introduced.
 * Opens DB directly (same pattern as backfill/prune commands).
 */

import type { Database } from "bun:sqlite";
import {
  DEFAULT_BINARY_DIR,
  DEFAULT_DB_PATH,
  DEFAULT_EMBED_MODEL_PATH,
  DEFAULT_EMBED_PORT,
  DEFAULT_GEN_MODEL_PATH,
  DEFAULT_GEN_PORT,
  DEFAULT_SERVER_TIMEOUT_MS,
} from "../constants";
import {
  createDatabase,
  getObservationsWithEmbeddingsButNoEdges,
  runMigrations,
  updateObservationGraphMetadata,
} from "../db/index";
import type { GraphManager } from "../graph/index";
import { createEdges, createGraphManager } from "../graph/index";
import { ensureLlamaServer } from "../models/ensure-server";
import type { ModelManager } from "../models/manager";
import { createModelManager } from "../models/manager";
import {
  getOrStartServer,
  type ManagedServer,
  stopServer,
} from "../models/server-manager";

const BATCH_SIZE = 50;

const DB_PATH = process.env.GOLDFISH_DB || DEFAULT_DB_PATH;
const BINARY_DIR = process.env.GOLDFISH_LLAMA_CLI_PATH || DEFAULT_BINARY_DIR;
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

const log = (msg: string) => console.log(`[graph:backfill] ${msg}`);

// ============================================================================
// Reusable backfill logic
// ============================================================================

export interface GraphBackfillOptions {
  readonly project?: string;
  readonly dryRun: boolean;
  readonly modelManager?: ModelManager;
}

export interface GraphBackfillResult {
  readonly candidates: number;
  readonly processed: number;
  readonly edgesCreated: number;
}

/**
 * Testable core: creates edges for observations with embeddings but no edges.
 */
export const runGraphBackfill = async (
  db: Database,
  graphManager: GraphManager,
  options: GraphBackfillOptions,
): Promise<GraphBackfillResult> => {
  // Count total candidates first
  const countResult = getObservationsWithEmbeddingsButNoEdges(db, {
    project: options.project,
    limit: 100_000,
  });
  if (!countResult.ok) {
    log(`Error counting candidates: ${countResult.error.message}`);
    return { candidates: 0, processed: 0, edgesCreated: 0 };
  }

  const totalCandidates = countResult.value.length;

  if (options.dryRun) {
    return { candidates: totalCandidates, processed: 0, edgesCreated: 0 };
  }

  let totalProcessed = 0;
  let totalEdgesCreated = 0;
  const zeroEdgeIds = new Set<number>();

  for (;;) {
    const batchResult = getObservationsWithEmbeddingsButNoEdges(db, {
      project: options.project,
      limit: BATCH_SIZE,
      excludeIds: zeroEdgeIds,
    });

    if (!batchResult.ok) {
      log(`Error fetching batch: ${batchResult.error.message}`);
      break;
    }

    const ids = batchResult.value;
    if (ids.length === 0) break;

    for (const observationId of ids) {
      const result = await createEdges(
        db,
        graphManager,
        { observationId },
        options.modelManager,
      );

      if (result.ok) {
        totalEdgesCreated += result.value.totalStored;
        if (result.value.totalStored === 0) {
          zeroEdgeIds.add(observationId);
        }
      } else {
        log(`Failed to create edges for #${observationId}`);
        zeroEdgeIds.add(observationId);
      }

      totalProcessed++;
    }

    log(`Processed ${totalProcessed} observations so far...`);
  }

  if (zeroEdgeIds.size > 0) {
    log(`${zeroEdgeIds.size} observations had no similar neighbors for edges`);
  }

  // Recompute graph metadata and store to all nodes
  const metadata = graphManager.recomputeMetadata();
  for (const [nodeId, meta] of metadata) {
    updateObservationGraphMetadata(db, {
      id: nodeId,
      centrality: meta.centrality,
      community: meta.community,
      degree: meta.degree,
    });
  }

  return {
    candidates: totalCandidates,
    processed: totalProcessed,
    edgesCreated: totalEdgesCreated,
  };
};

// ============================================================================
// CLI entry point
// ============================================================================

export const main = async (): Promise<void> => {
  const args = process.argv.slice(3);
  const dryRun = args.includes("--dry-run");
  const noLlm = args.includes("--no-llm");
  const projectIdx = args.indexOf("--project");
  const project =
    projectIdx >= 0 && projectIdx + 1 < args.length
      ? args[projectIdx + 1]
      : undefined;

  if (dryRun) {
    log("Dry run mode — counting candidates without creating edges");
  }

  log(`Opening database: ${DB_PATH}`);
  const db = createDatabase(DB_PATH);
  runMigrations(db);

  const graphManager = createGraphManager();
  const hydrateResult = graphManager.hydrate(db);
  if (hydrateResult.ok) {
    log(`Graph hydrated with ${hydrateResult.value} existing edges`);
  }

  let modelManager: ModelManager | undefined;
  const servers: ManagedServer[] = [];

  if (!noLlm && !dryRun) {
    // Ensure llama-server binary is available
    const ensureResult = await ensureLlamaServer(BINARY_DIR);
    if (!ensureResult.ok) {
      log(`Failed to ensure llama-server: ${ensureResult.error.message}`);
      db.close();
      return;
    }

    // Start generative server
    const genModelPath =
      process.env.GOLDFISH_LLAMA_MODEL || DEFAULT_GEN_MODEL_PATH;
    const genResult = await getOrStartServer(
      {
        binaryDir: BINARY_DIR,
        modelPath: genModelPath,
        port: GEN_PORT,
        contextSize: 4096,
        embeddings: false,
      },
      SERVER_TIMEOUT,
    );

    if (!genResult.ok) {
      log(`Failed to acquire generative server: ${genResult.error.message}`);
      db.close();
      return;
    }
    servers.push(genResult.value);

    // Start embedding server
    const embedModelPath =
      process.env.GOLDFISH_LLAMA_EMBEDDING_MODEL || DEFAULT_EMBED_MODEL_PATH;
    const embedResult = await getOrStartServer(
      {
        binaryDir: BINARY_DIR,
        modelPath: embedModelPath,
        port: EMBED_PORT,
        contextSize: 512,
        embeddings: true,
      },
      SERVER_TIMEOUT,
    );

    if (!embedResult.ok) {
      log(`Failed to acquire embedding server: ${embedResult.error.message}`);
      for (const s of servers) await stopServer(s);
      db.close();
      return;
    }
    servers.push(embedResult.value);

    modelManager = createModelManager({
      generationUrl: genResult.value.url,
      embeddingUrl: embedResult.value.url,
    });

    log("LLM servers started (tier 3 enabled)");
  } else if (noLlm) {
    log("LLM disabled (--no-llm) — tier 1+2 only");
  }

  const result = await runGraphBackfill(db, graphManager, {
    project,
    dryRun,
    modelManager,
  });

  if (dryRun) {
    log(`Found ${result.candidates} observations needing edges`);
  } else {
    log(
      `Backfill complete: ${result.processed} processed, ${result.edgesCreated} edges created`,
    );
  }

  if (modelManager) await modelManager.dispose();
  for (const s of servers) await stopServer(s);
  db.close();
};
