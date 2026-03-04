/**
 * Tiered edge creation pipeline for the knowledge graph.
 * Orchestrates tier 1 (pure computation) and tier 2 (heuristic rules).
 *
 * Shared types and helpers (ObservationContext, jaccardCoefficient, intersect)
 * are exported from here for use by tier modules.
 */

import type { Database } from "bun:sqlite";
import {
  getObservationById,
  getObservationsWithEmbeddings,
  storeEdge,
} from "../db/index";
import type { ModelManager } from "../models/manager";
import type { KnowledgeGraphEdge, Observation } from "../types/domain";
import { ok, type Result } from "../types/result";
import { cosineSimilarity } from "../utils/relevance";
import type { ObservationContext, ProposedEdge } from "./linker-shared";
import {
  findConceptOverlapEdges,
  findFileOverlapEdges,
  findSessionEdges,
  findSimilarityEdges,
} from "./linker-tier1";
import {
  inferCausedByEdges,
  inferImplementsEdges,
  inferSupersedesEdges,
} from "./linker-tier2";
import { enrichWithLLM } from "./linker-tier3";
import type { GraphManager } from "./manager";

// Re-export shared types for consumers
export type { ObservationContext, ProposedEdge } from "./linker-shared";
export { intersect, jaccardCoefficient } from "./linker-shared";

// Re-export tier functions for consumers (tests import from linker.ts)
export {
  findConceptOverlapEdges,
  findFileOverlapEdges,
  findSessionEdges,
  findSimilarityEdges,
} from "./linker-tier1";
export {
  inferCausedByEdges,
  inferImplementsEdges,
  inferSupersedesEdges,
} from "./linker-tier2";
export type { Tier3Candidate, Tier3Input } from "./linker-tier3";
// Re-export tier 3 for consumers
export { enrichWithLLM } from "./linker-tier3";

export interface CreateEdgesInput {
  readonly observationId: number;
}

export interface CreateEdgesResult {
  readonly tier1Count: number;
  readonly tier2Count: number;
  readonly tier3Count: number;
  readonly totalStored: number;
}

// ============================================================================
// Configuration
// ============================================================================

const MAX_CANDIDATES = 200;

// ============================================================================
// Helpers
// ============================================================================

const log = (msg: string) => console.log(`[linker] ${msg}`);

/**
 * Loads observation context with embedding for the given observation ID.
 */
const loadObservationContext = (
  db: Database,
  observationId: number,
  embeddingMap: Map<number, Float32Array>,
): ObservationContext | null => {
  const result = getObservationById(db, observationId);
  if (!result.ok || !result.value) return null;

  const obs = result.value;
  return {
    id: obs.id,
    type: obs.type,
    sdkSessionId: obs.sdkSessionId,
    project: obs.project,
    filesModified: obs.filesModified,
    filesRead: obs.filesRead,
    concepts: obs.concepts,
    promptNumber: obs.promptNumber,
    createdAtEpoch: obs.createdAtEpoch,
    embedding: embeddingMap.get(obs.id) ?? null,
  };
};

// ============================================================================
// Orchestrator
// ============================================================================

/**
 * Runs the full edge creation pipeline for a newly stored observation.
 * Tier 1 + 2 are always-on. Tier 3 (LLM) is controlled by env var.
 */
export const createEdges = async (
  db: Database,
  graphManager: GraphManager,
  input: CreateEdgesInput,
  modelManager?: ModelManager,
): Promise<Result<CreateEdgesResult>> => {
  const { observationId } = input;

  // Load all observations with embeddings for candidate comparison
  const embeddedResult = getObservationsWithEmbeddings(db, {
    limit: MAX_CANDIDATES,
  });
  if (!embeddedResult.ok) {
    return ok({ tier1Count: 0, tier2Count: 0, tier3Count: 0, totalStored: 0 });
  }

  const embeddedObs = embeddedResult.value;
  const embeddingMap = new Map<number, Float32Array>();
  for (const obs of embeddedObs) {
    embeddingMap.set(obs.id, obs.embedding);
  }

  // Load source observation context
  const sourceCtx = loadObservationContext(db, observationId, embeddingMap);
  if (!sourceCtx) {
    log(`Observation ${observationId} not found, skipping link`);
    return ok({ tier1Count: 0, tier2Count: 0, tier3Count: 0, totalStored: 0 });
  }

  // Convert embedded observations to Observation shape for tier 1+2 functions
  const candidateObs: Observation[] = embeddedObs.map((e) => ({
    id: e.id,
    sdkSessionId: e.sdkSessionId,
    project: e.project,
    type: e.type as Observation["type"],
    title: e.title,
    subtitle: null,
    narrative: e.narrative,
    facts: [],
    concepts: [],
    filesRead: [],
    filesModified: [],
    promptNumber: 0,
    discoveryTokens: 0,
    createdAt: "",
    createdAtEpoch: e.createdAtEpoch,
  }));

  // We also need full observations for file/concept comparison.
  // Load the source observation's nearby observations (same session, recent).
  const recentResult = getRecentObservationsForLinking(db, sourceCtx);
  const recentObs = recentResult ?? [];

  // Merge candidate sets (embedded for similarity, recent for file/session edges)
  const allCandidateMap = new Map<number, Observation>();
  for (const obs of candidateObs) {
    allCandidateMap.set(obs.id, obs);
  }
  for (const obs of recentObs) {
    if (!allCandidateMap.has(obs.id)) {
      allCandidateMap.set(obs.id, obs);
    }
  }
  const allCandidates = Array.from(allCandidateMap.values());

  // --- Tier 1 ---
  const tier1Edges: ProposedEdge[] = [
    ...findSimilarityEdges(
      sourceCtx,
      embeddedObs.map((e) => ({ id: e.id, embedding: e.embedding })),
    ),
    ...findFileOverlapEdges(sourceCtx, allCandidates),
    ...findConceptOverlapEdges(sourceCtx, allCandidates),
    ...findSessionEdges(sourceCtx, allCandidates),
  ];

  // --- Tier 2 ---
  const tier2Edges: ProposedEdge[] = [
    ...inferSupersedesEdges(sourceCtx, allCandidates, embeddingMap),
    ...inferCausedByEdges(sourceCtx, allCandidates),
    ...inferImplementsEdges(sourceCtx, allCandidates),
  ];

  // --- Tier 3 (LLM enrichment) ---
  let tier3Edges: ProposedEdge[] = [];
  const llmEnabled = process.env.GOLDFISH_GRAPH_LLM !== "false";

  if (llmEnabled && modelManager && sourceCtx.embedding) {
    const tier3Candidates = embeddedObs.map((e) => ({
      id: e.id,
      similarity:
        sourceCtx.embedding && e.embedding
          ? cosineSimilarity(sourceCtx.embedding, e.embedding)
          : 0,
    }));

    try {
      tier3Edges = [
        ...(await enrichWithLLM(db, graphManager, modelManager, {
          observationId,
          candidates: tier3Candidates,
        })),
      ];
    } catch (e) {
      log(
        `Tier 3 error for obs #${observationId}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  // --- Store edges ---
  const allEdges = [...tier1Edges, ...tier2Edges, ...tier3Edges];
  let totalStored = 0;

  for (const edge of allEdges) {
    const storeResult = storeEdge(db, {
      sourceId: edge.sourceId,
      targetId: edge.targetId,
      relation: edge.relation,
      weight: edge.weight,
      direction: edge.direction,
      explanation: edge.explanation,
    });

    if (storeResult.ok) {
      totalStored++;
      // Update in-memory graph
      const edgeId = storeResult.value;
      if (edgeId > 0) {
        const kgEdge: KnowledgeGraphEdge = {
          id: edgeId,
          sourceId: edge.sourceId,
          targetId: edge.targetId,
          relation: edge.relation,
          weight: edge.weight,
          direction: edge.direction,
          explanation: edge.explanation,
          metadata: null,
          createdAtEpoch: Date.now(),
        };
        graphManager.addEdge(kgEdge);
      }
    }
  }

  log(
    `Edges created for obs #${observationId}: tier1=${tier1Edges.length}, tier2=${tier2Edges.length}, tier3=${tier3Edges.length}, stored=${totalStored}`,
  );

  return ok({
    tier1Count: tier1Edges.length,
    tier2Count: tier2Edges.length,
    tier3Count: tier3Edges.length,
    totalStored,
  });
};

// ============================================================================
// DB helpers for linking
// ============================================================================

/**
 * Gets recent observations with full data (files, concepts, session) for linking.
 * Returns observations from the same session and recent observations with file data.
 */
const getRecentObservationsForLinking = (
  db: Database,
  sourceCtx: ObservationContext,
): readonly Observation[] | null => {
  try {
    const rows = db
      .query<
        {
          id: number;
          sdk_session_id: string;
          project: string;
          type: string;
          title: string | null;
          subtitle: string | null;
          narrative: string | null;
          facts: string | null;
          concepts: string | null;
          files_read: string | null;
          files_modified: string | null;
          prompt_number: number;
          discovery_tokens: number;
          created_at: string;
          created_at_epoch: number;
        },
        [string, number]
      >(
        `SELECT id, sdk_session_id, project, type, title, subtitle, narrative,
                facts, concepts, files_read, files_modified,
                prompt_number, discovery_tokens, created_at, created_at_epoch
         FROM observations
         WHERE sdk_session_id = ? OR id IN (
           SELECT id FROM observations ORDER BY created_at_epoch DESC LIMIT ?
         )
         ORDER BY created_at_epoch DESC`,
      )
      .all(sourceCtx.sdkSessionId, MAX_CANDIDATES);

    return rows.map((row) => ({
      id: row.id,
      sdkSessionId: row.sdk_session_id,
      project: row.project,
      type: row.type as Observation["type"],
      title: row.title,
      subtitle: row.subtitle,
      narrative: row.narrative,
      facts: parseJsonArray(row.facts),
      concepts: parseJsonArray(row.concepts),
      filesRead: parseJsonArray(row.files_read),
      filesModified: parseJsonArray(row.files_modified),
      promptNumber: row.prompt_number,
      discoveryTokens: row.discovery_tokens,
      createdAt: row.created_at,
      createdAtEpoch: row.created_at_epoch,
    }));
  } catch {
    return null;
  }
};

const parseJsonArray = (json: string | null): readonly string[] => {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};
