/**
 * Knowledge graph edge operations.
 */

import type { Database } from "bun:sqlite";
import type {
  EdgeDirection,
  EdgeRelationType,
  KnowledgeGraphEdge,
} from "../types/domain";
import { fromTry, type Result } from "../types/result";
import { type EdgeRow, rowToEdge } from "./converters";

// ============================================================================
// Types
// ============================================================================

interface StoreEdgeInput {
  readonly sourceId: number;
  readonly targetId: number;
  readonly relation: EdgeRelationType;
  readonly weight: number;
  readonly direction: EdgeDirection;
  readonly explanation?: string | null;
  readonly metadata?: Record<string, unknown> | null;
}

interface UpdateGraphMetadataInput {
  readonly id: number;
  readonly centrality: number | null;
  readonly community: number | null;
  readonly degree: number;
}

// ============================================================================
// Operations
// ============================================================================

/**
 * Stores a knowledge graph edge. Uses INSERT OR IGNORE for dedup via unique constraint.
 * Returns the edge ID (new or existing).
 */
export const storeEdge = (
  db: Database,
  input: StoreEdgeInput,
): Result<number> => {
  const {
    sourceId,
    targetId,
    relation,
    weight,
    direction,
    explanation = null,
    metadata = null,
  } = input;
  const now = Date.now();

  // Normalize bidirectional edges so source_id < target_id.
  // This ensures the UNIQUE(source_id, target_id, relation) constraint
  // catches duplicates regardless of insertion order.
  const normalizedSource =
    direction === "bidirectional" ? Math.min(sourceId, targetId) : sourceId;
  const normalizedTarget =
    direction === "bidirectional" ? Math.max(sourceId, targetId) : targetId;

  return fromTry(() => {
    const result = db.run(
      `INSERT OR IGNORE INTO kg_edges
       (source_id, target_id, relation, weight, direction, explanation, metadata, created_at_epoch)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        normalizedSource,
        normalizedTarget,
        relation,
        weight,
        direction,
        explanation,
        metadata ? JSON.stringify(metadata) : null,
        now,
      ],
    );

    if (result.changes > 0) {
      return Number(result.lastInsertRowid);
    }

    // Edge already exists — return existing ID
    const existing = db
      .query<{ id: number }, [number, number, string]>(
        "SELECT id FROM kg_edges WHERE source_id = ? AND target_id = ? AND relation = ?",
      )
      .get(normalizedSource, normalizedTarget, relation);

    return existing ? existing.id : 0;
  });
};

/**
 * Gets all edges connected to an observation (as source or target).
 */
export const getEdgesByObservation = (
  db: Database,
  input: { readonly observationId: number },
): Result<readonly KnowledgeGraphEdge[]> => {
  return fromTry(() => {
    const rows = db
      .query<EdgeRow, [number, number]>(
        `SELECT * FROM kg_edges WHERE source_id = ? OR target_id = ? ORDER BY weight DESC`,
      )
      .all(input.observationId, input.observationId);

    return rows.map(rowToEdge);
  });
};

/**
 * Gets direct edges between two observations.
 */
export const getEdgesBetween = (
  db: Database,
  input: { readonly sourceId: number; readonly targetId: number },
): Result<readonly KnowledgeGraphEdge[]> => {
  return fromTry(() => {
    const rows = db
      .query<EdgeRow, [number, number, number, number]>(
        `SELECT * FROM kg_edges
         WHERE (source_id = ? AND target_id = ?) OR (source_id = ? AND target_id = ?)`,
      )
      .all(input.sourceId, input.targetId, input.targetId, input.sourceId);

    return rows.map(rowToEdge);
  });
};

/**
 * Gets all edges for Graphology hydration on startup.
 */
export const getAllEdges = (
  db: Database,
  input: { readonly limit?: number },
): Result<readonly KnowledgeGraphEdge[]> => {
  return fromTry(() => {
    const sql = input.limit
      ? "SELECT * FROM kg_edges ORDER BY id LIMIT ?"
      : "SELECT * FROM kg_edges ORDER BY id";
    const params = input.limit ? [input.limit] : [];

    const rows = db.query<EdgeRow, number[]>(sql).all(...params);

    return rows.map(rowToEdge);
  });
};

/**
 * Deletes all edges connected to an observation.
 */
export const deleteEdgesByObservation = (
  db: Database,
  input: { readonly observationId: number },
): Result<number> => {
  return fromTry(() => {
    const result = db.run(
      "DELETE FROM kg_edges WHERE source_id = ? OR target_id = ?",
      [input.observationId, input.observationId],
    );
    return result.changes;
  });
};

/**
 * Updates precomputed graph metadata on an observation.
 */
export const updateObservationGraphMetadata = (
  db: Database,
  input: UpdateGraphMetadataInput,
): Result<void> => {
  return fromTry(() => {
    db.run(
      `UPDATE observations
       SET graph_centrality = ?, graph_community = ?, graph_degree = ?
       WHERE id = ?`,
      [input.centrality, input.community, input.degree, input.id],
    );
  });
};
