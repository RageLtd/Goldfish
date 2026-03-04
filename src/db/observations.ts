/**
 * Observation CRUD, search, embedding, pruning, and deduplication operations.
 */

import type { Database } from "bun:sqlite";
import type { Observation, ParsedObservation } from "../types/domain";
import { fromTry, ok, type Result } from "../types/result";
import { type ObservationRow, rowToObservation } from "./converters";

// ============================================================================
// Core CRUD
// ============================================================================

interface StoreObservationInput {
  readonly claudeSessionId: string;
  readonly project: string;
  readonly observation: ParsedObservation;
  readonly promptNumber: number;
  readonly discoveryTokens?: number;
}

/**
 * Stores an observation.
 */
export const storeObservation = (
  db: Database,
  input: StoreObservationInput,
): Result<number> => {
  const {
    claudeSessionId,
    project,
    observation,
    promptNumber,
    discoveryTokens = 0,
  } = input;
  const now = new Date();

  return fromTry(() => {
    const result = db.run(
      `INSERT INTO observations
       (sdk_session_id, project, type, title, subtitle, narrative, facts, concepts,
        files_read, files_modified, prompt_number, discovery_tokens, created_at, created_at_epoch)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        claudeSessionId,
        project,
        observation.type,
        observation.title,
        observation.subtitle,
        observation.narrative,
        JSON.stringify(observation.facts),
        JSON.stringify(observation.concepts),
        JSON.stringify(observation.filesRead),
        JSON.stringify(observation.filesModified),
        promptNumber,
        discoveryTokens,
        now.toISOString(),
        now.getTime(),
      ],
    );

    return Number(result.lastInsertRowid);
  });
};

/**
 * Gets an observation by ID.
 */
export const getObservationById = (
  db: Database,
  id: number,
): Result<Observation | null> => {
  return fromTry(() => {
    const row = db
      .query<ObservationRow, [number]>(
        `SELECT * FROM observations WHERE id = ?`,
      )
      .get(id);

    if (!row) {
      return null;
    }

    return rowToObservation(row);
  });
};

interface GetRecentObservationsInput {
  readonly project?: string;
  readonly limit: number;
}

/**
 * Gets recent observations, optionally filtered by project.
 */
export const getRecentObservations = (
  db: Database,
  input: GetRecentObservationsInput,
): Result<readonly Observation[]> => {
  const { project, limit } = input;

  return fromTry(() => {
    let query = "SELECT * FROM observations";
    const params: (string | number)[] = [];

    if (project) {
      query += " WHERE project = ?";
      params.push(project);
    }

    query += " ORDER BY id DESC LIMIT ?";
    params.push(limit);

    const rows = db
      .query<ObservationRow, (string | number)[]>(query)
      .all(...params);

    return rows.map(rowToObservation);
  });
};

// ============================================================================
// Search
// ============================================================================

interface SearchInput {
  readonly query: string;
  readonly concept?: string;
  readonly project?: string;
  readonly limit: number;
}

/**
 * Searches observations using FTS5 with optional concept filtering.
 * When concept is provided, filters to observations containing that concept tag.
 * The concept filter uses JSON contains to match against the concepts array.
 */
export const searchObservations = (
  db: Database,
  input: SearchInput,
): Result<readonly Observation[]> => {
  const { query, concept, project, limit } = input;

  return fromTry(() => {
    let sql = `
      SELECT o.*, fts.rank
      FROM observations o
      JOIN observations_fts fts ON o.id = fts.rowid
      WHERE observations_fts MATCH ?
    `;
    const params: (string | number)[] = [query];

    // Add concept filter if provided
    if (concept) {
      sql += ` AND EXISTS (
          SELECT 1 FROM json_each(o.concepts)
          WHERE LOWER(json_each.value) = LOWER(?)
        )`;
      params.push(concept);
    }

    if (project) {
      sql += " AND o.project = ?";
      params.push(project);
    }

    sql += " ORDER BY fts.rank LIMIT ?";
    params.push(limit);

    const rows = db
      .query<ObservationRow & { rank: number }, (string | number)[]>(sql)
      .all(...params);

    return rows.map(rowToObservation);
  });
};

// ============================================================================
// Cross-Project Candidate Retrieval
// ============================================================================

interface GetCandidateObservationsInput {
  readonly limit: number;
  readonly ftsQuery?: string;
}

export interface ObservationWithRank extends Observation {
  readonly ftsRank: number;
  readonly hasEmbedding: boolean;
}

/**
 * Gets candidate observations across ALL projects for relevance scoring.
 * When ftsQuery is provided, uses FTS5 for keyword matching and returns rank.
 * When no ftsQuery, returns recent observations ordered by epoch.
 */
export const getCandidateObservations = (
  db: Database,
  input: GetCandidateObservationsInput,
): Result<readonly ObservationWithRank[]> => {
  const { limit, ftsQuery } = input;

  return fromTry(() => {
    if (ftsQuery) {
      const sql = `
        SELECT o.id, o.sdk_session_id, o.project, o.type, o.title, o.subtitle,
               o.narrative, o.facts, o.concepts, o.files_read, o.files_modified,
               o.prompt_number, o.discovery_tokens, o.created_at, o.created_at_epoch,
               (o.embedding IS NOT NULL) AS has_embedding,
               fts.rank as fts_rank
        FROM observations o
        JOIN observations_fts fts ON o.id = fts.rowid
        WHERE observations_fts MATCH ?
        ORDER BY fts.rank
        LIMIT ?
      `;
      const rows = db
        .query<
          Omit<ObservationRow, "embedding"> & {
            has_embedding: number;
            fts_rank: number;
          },
          [string, number]
        >(sql)
        .all(ftsQuery, limit);

      return rows.map((row) => ({
        ...rowToObservation({ ...row, embedding: null }),
        ftsRank: row.fts_rank,
        hasEmbedding: row.has_embedding === 1,
      }));
    }

    // No FTS query — return recent from all projects
    const sql = `
      SELECT id, sdk_session_id, project, type, title, subtitle,
             narrative, facts, concepts, files_read, files_modified,
             prompt_number, discovery_tokens, created_at, created_at_epoch,
             (embedding IS NOT NULL) AS has_embedding,
             0 as fts_rank
      FROM observations
      ORDER BY created_at_epoch DESC
      LIMIT ?
    `;
    const rows = db
      .query<
        Omit<ObservationRow, "embedding"> & {
          has_embedding: number;
          fts_rank: number;
        },
        [number]
      >(sql)
      .all(limit);

    return rows.map((row) => ({
      ...rowToObservation({ ...row, embedding: null }),
      ftsRank: 0,
      hasEmbedding: row.has_embedding === 1,
    }));
  });
};

// ============================================================================
// Embedding Operations
// ============================================================================

interface GetEmbeddingsByIdsInput {
  readonly ids: readonly number[];
}

/**
 * Fetches embedding BLOBs for specific observation IDs.
 * Returns a map of observation ID to Float32Array embedding.
 */
export const getEmbeddingsByIds = (
  db: Database,
  input: GetEmbeddingsByIdsInput,
): Result<Map<number, Float32Array>> => {
  const { ids } = input;
  if (ids.length === 0) return ok(new Map());

  return fromTry(() => {
    const placeholders = ids.map(() => "?").join(",");
    const rows = db
      .query<{ id: number; embedding: Buffer }, number[]>(
        `SELECT id, embedding FROM observations WHERE id IN (${placeholders}) AND embedding IS NOT NULL`,
      )
      .all(...ids);

    const result = new Map<number, Float32Array>();
    for (const row of rows) {
      result.set(
        row.id,
        new Float32Array(
          row.embedding.buffer,
          row.embedding.byteOffset,
          row.embedding.byteLength / 4,
        ),
      );
    }
    return result;
  });
};

interface GetObservationsWithoutEmbeddingsInput {
  readonly limit: number;
}

/**
 * Returns observations lacking embeddings, for backfill processing.
 */
export const getObservationsWithoutEmbeddings = (
  db: Database,
  input: GetObservationsWithoutEmbeddingsInput,
): Result<
  readonly {
    readonly id: number;
    readonly title: string;
    readonly narrative: string;
  }[]
> => {
  return fromTry(() => {
    const rows = db
      .query<
        { id: number; title: string | null; narrative: string | null },
        [number]
      >(
        `SELECT id, title, narrative FROM observations WHERE embedding IS NULL ORDER BY id LIMIT ?`,
      )
      .all(input.limit);

    return rows.map((row) => ({
      id: row.id,
      title: row.title ?? "",
      narrative: row.narrative ?? "",
    }));
  });
};

/**
 * Stores a pre-computed embedding BLOB for an observation.
 */
export const updateObservationEmbedding = (
  db: Database,
  id: number,
  embedding: Float32Array,
): Result<void> => {
  return fromTry(() => {
    db.run("UPDATE observations SET embedding = ? WHERE id = ?", [
      Buffer.from(embedding.buffer),
      id,
    ]);
  });
};

/**
 * Gets observations with their embeddings for semantic comparison.
 * Returns only observations that have embeddings.
 */
export const getObservationsWithEmbeddings = (
  db: Database,
  input: { readonly limit?: number },
): Result<
  readonly {
    readonly id: number;
    readonly title: string | null;
    readonly narrative: string | null;
    readonly project: string;
    readonly type: string;
    readonly createdAtEpoch: number;
    readonly sdkSessionId: string;
    readonly embedding: Float32Array;
  }[]
> => {
  return fromTry(() => {
    const rows = db
      .query<
        {
          id: number;
          title: string | null;
          narrative: string | null;
          project: string;
          type: string;
          created_at_epoch: number;
          sdk_session_id: string;
          embedding: Buffer;
        },
        [number]
      >(
        `SELECT id, title, narrative, project, type, created_at_epoch,
                sdk_session_id, embedding
         FROM observations
         WHERE embedding IS NOT NULL
         ORDER BY created_at_epoch DESC
         ${input.limit != null ? "LIMIT ?" : ""}`,
      )
      .all(...(input.limit != null ? [input.limit] : []));

    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      narrative: row.narrative,
      project: row.project,
      type: row.type,
      createdAtEpoch: row.created_at_epoch,
      sdkSessionId: row.sdk_session_id,
      embedding: new Float32Array(
        row.embedding.buffer,
        row.embedding.byteOffset,
        row.embedding.byteLength / 4,
      ),
    }));
  });
};

// ============================================================================
// Graph Backfill
// ============================================================================

interface GetObservationsWithEmbeddingsButNoEdgesInput {
  readonly project?: string;
  readonly limit: number;
  readonly excludeIds?: ReadonlySet<number>;
}

/**
 * Returns IDs of observations that have embeddings but no knowledge graph edges.
 * Used by the graph:backfill command to find candidates for edge creation.
 */
export const getObservationsWithEmbeddingsButNoEdges = (
  db: Database,
  input: GetObservationsWithEmbeddingsButNoEdgesInput,
): Result<readonly number[]> => {
  const { project, limit, excludeIds } = input;

  return fromTry(() => {
    let sql = `
      SELECT o.id FROM observations o
      WHERE o.embedding IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM kg_edges WHERE source_id = o.id OR target_id = o.id)
    `;
    const params: (string | number)[] = [];

    if (project) {
      sql += " AND o.project = ?";
      params.push(project);
    }

    if (excludeIds && excludeIds.size > 0) {
      const placeholders = Array.from(excludeIds, () => "?").join(",");
      sql += ` AND o.id NOT IN (${placeholders})`;
      for (const id of excludeIds) params.push(id);
    }

    sql += " ORDER BY o.id LIMIT ?";
    params.push(limit);

    const rows = db
      .query<{ id: number }, (string | number)[]>(sql)
      .all(...params);

    return rows.map((row) => row.id);
  });
};

// ============================================================================
// Pruning Operations
// ============================================================================

/**
 * Deletes observations by ID list. Returns count of deleted rows.
 */
export const deleteObservationsByIds = (
  db: Database,
  input: { readonly ids: readonly number[] },
): Result<number> => {
  const { ids } = input;
  if (ids.length === 0) return ok(0);

  return fromTry(() => {
    const placeholders = ids.map(() => "?").join(",");
    const result = db.run(
      `DELETE FROM observations WHERE id IN (${placeholders})`,
      ids as number[],
    );
    return result.changes;
  });
};

export interface PruneCandidate {
  readonly id: number;
  readonly title: string | null;
  readonly type: string;
  readonly project: string;
  readonly createdAtEpoch: number;
  readonly hasEmbedding: boolean;
}

/**
 * Gets all observations with metadata for pruning decisions.
 */
export const getObservationsForPruning = (
  db: Database,
): Result<readonly PruneCandidate[]> => {
  return fromTry(() => {
    const rows = db
      .query<
        {
          id: number;
          title: string | null;
          type: string;
          project: string;
          created_at_epoch: number;
          has_embedding: number;
        },
        []
      >(
        `SELECT id, title, type, project, created_at_epoch,
                (embedding IS NOT NULL) AS has_embedding
         FROM observations
         ORDER BY created_at_epoch DESC`,
      )
      .all();

    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      type: row.type,
      project: row.project,
      createdAtEpoch: row.created_at_epoch,
      hasEmbedding: row.has_embedding === 1,
    }));
  });
};

// ============================================================================
// Deduplication
// ============================================================================

interface FindSimilarInput {
  readonly project: string;
  readonly title: string;
  readonly withinMs: number;
}

/**
 * Jaccard similarity on word tokens.
 */
export const jaccardSimilarity = (a: string, b: string): number => {
  const wordsA = new Set(a.toLowerCase().split(/\s+/));
  const wordsB = new Set(b.toLowerCase().split(/\s+/));
  if (wordsA.size === 0 && wordsB.size === 0) return 1;
  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let intersection = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection++;
  }
  const union = wordsA.size + wordsB.size - intersection;
  return union === 0 ? 0 : intersection / union;
};

/**
 * Finds a near-duplicate observation in the same project within a time window.
 * Returns the matching observation if Jaccard similarity > 0.8, null otherwise.
 */
export const findSimilarObservation = (
  db: Database,
  input: FindSimilarInput,
): Result<Observation | null> => {
  const { project, title, withinMs } = input;
  const cutoff = Date.now() - withinMs;

  return fromTry(() => {
    const rows = db
      .query<ObservationRow, [string, number]>(
        `SELECT * FROM observations
         WHERE project = ? AND created_at_epoch > ?
         ORDER BY created_at_epoch DESC
         LIMIT 20`,
      )
      .all(project, cutoff);

    for (const row of rows) {
      if (row.title && jaccardSimilarity(title, row.title) > 0.8) {
        return rowToObservation(row);
      }
    }

    return null;
  });
};
