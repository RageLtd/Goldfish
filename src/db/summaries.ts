/**
 * Session summary CRUD and search operations.
 */

import type { Database } from "bun:sqlite";
import type { ParsedSummary, SessionSummary } from "../types/domain";
import { fromTry, type Result } from "../types/result";
import { rowToSummary, type SummaryRow } from "./converters";

// ============================================================================
// Types
// ============================================================================

interface StoreSummaryInput {
  readonly claudeSessionId: string;
  readonly project: string;
  readonly summary: ParsedSummary;
  readonly promptNumber: number;
  readonly discoveryTokens?: number;
}

interface GetRecentSummariesInput {
  readonly project?: string;
  readonly limit: number;
}

interface SearchInput {
  readonly query: string;
  readonly project?: string;
  readonly limit: number;
}

// ============================================================================
// Operations
// ============================================================================

/**
 * Stores a session summary.
 */
export const storeSummary = (
  db: Database,
  input: StoreSummaryInput,
): Result<number> => {
  const {
    claudeSessionId,
    project,
    summary,
    promptNumber,
    discoveryTokens = 0,
  } = input;
  const now = new Date();

  return fromTry(() => {
    const result = db.run(
      `INSERT INTO session_summaries
       (sdk_session_id, project, request, investigated, learned, completed,
        next_steps, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        claudeSessionId,
        project,
        summary.request,
        summary.investigated,
        summary.learned,
        summary.completed,
        summary.nextSteps,
        summary.notes,
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
 * Gets recent summaries, optionally filtered by project.
 */
export const getRecentSummaries = (
  db: Database,
  input: GetRecentSummariesInput,
): Result<readonly SessionSummary[]> => {
  const { project, limit } = input;

  return fromTry(() => {
    let query = "SELECT * FROM session_summaries";
    const params: (string | number)[] = [];

    if (project) {
      query += " WHERE project = ?";
      params.push(project);
    }

    query += " ORDER BY created_at_epoch DESC LIMIT ?";
    params.push(limit);

    const rows = db
      .query<SummaryRow, (string | number)[]>(query)
      .all(...params);

    return rows.map(rowToSummary);
  });
};

/**
 * Searches summaries using FTS5.
 */
export const searchSummaries = (
  db: Database,
  input: SearchInput,
): Result<readonly SessionSummary[]> => {
  const { query, project, limit } = input;

  return fromTry(() => {
    let sql = `
      SELECT s.*, fts.rank
      FROM session_summaries s
      JOIN session_summaries_fts fts ON s.id = fts.rowid
      WHERE session_summaries_fts MATCH ?
    `;
    const params: (string | number)[] = [query];

    if (project) {
      sql += " AND s.project = ?";
      params.push(project);
    }

    sql += " ORDER BY fts.rank LIMIT ?";
    params.push(limit);

    const rows = db
      .query<SummaryRow & { rank: number }, (string | number)[]>(sql)
      .all(...params);

    return rows.map(rowToSummary);
  });
};
