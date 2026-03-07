/**
 * Database operations for the codebase map.
 * Pure functions taking db: Database as first arg.
 */

import type { Database } from "bun:sqlite";
import { err, ok, type Result } from "../types/result";

// ============================================================================
// Types
// ============================================================================

export interface CodebaseMapEntry {
  readonly id: number;
  readonly project: string;
  readonly path: string;
  readonly type: "directory" | "file";
  readonly summary: string | null;
  readonly fileHash: string | null;
  readonly lastScannedEpoch: number;
}

export interface UpsertMapEntryInput {
  readonly project: string;
  readonly path: string;
  readonly type: "directory" | "file";
  readonly summary: string | null;
  readonly fileHash: string | null;
}

interface MapRow {
  readonly id: number;
  readonly project: string;
  readonly path: string;
  readonly type: string;
  readonly summary: string | null;
  readonly file_hash: string | null;
  readonly last_scanned_epoch: number;
}

const rowToEntry = (row: MapRow): CodebaseMapEntry => ({
  id: row.id,
  project: row.project,
  path: row.path,
  type: row.type as "directory" | "file",
  summary: row.summary,
  fileHash: row.file_hash,
  lastScannedEpoch: row.last_scanned_epoch,
});

// ============================================================================
// Operations
// ============================================================================

export const upsertMapEntry = (
  db: Database,
  input: UpsertMapEntryInput,
): Result<number, Error> => {
  try {
    const now = Math.floor(Date.now() / 1000);
    const stmt = db.prepare(`
      INSERT INTO codebase_map (project, path, type, summary, file_hash, last_scanned_epoch)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(project, path) DO UPDATE SET
        summary = excluded.summary,
        file_hash = excluded.file_hash,
        last_scanned_epoch = excluded.last_scanned_epoch
    `);
    const result = stmt.run(
      input.project,
      input.path,
      input.type,
      input.summary,
      input.fileHash,
      now,
    );
    return ok(Number(result.lastInsertRowid));
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }
};

export const getMapEntry = (
  db: Database,
  project: string,
  path: string,
): Result<CodebaseMapEntry | null, Error> => {
  try {
    const row = db
      .prepare("SELECT * FROM codebase_map WHERE project = ? AND path = ?")
      .get(project, path) as MapRow | null;
    return ok(row ? rowToEntry(row) : null);
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }
};

export const getDirectoryMap = (
  db: Database,
  project: string,
): Result<readonly CodebaseMapEntry[], Error> => {
  try {
    const rows = db
      .prepare(
        "SELECT * FROM codebase_map WHERE project = ? AND type = 'directory' ORDER BY path",
      )
      .all(project) as MapRow[];
    return ok(rows.map(rowToEntry));
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }
};

export const getFileMap = (
  db: Database,
  project: string,
  directory?: string,
): Result<readonly CodebaseMapEntry[], Error> => {
  try {
    let rows: MapRow[];
    if (directory) {
      // Match files directly within this directory (not nested subdirs)
      const prefix = directory.endsWith("/") ? directory : `${directory}/`;
      rows = db
        .prepare(
          `SELECT * FROM codebase_map
           WHERE project = ? AND type = 'file' AND path LIKE ? AND path NOT LIKE ?
           ORDER BY path`,
        )
        .all(project, `${prefix}%`, `${prefix}%/%`) as MapRow[];
    } else {
      rows = db
        .prepare(
          "SELECT * FROM codebase_map WHERE project = ? AND type = 'file' ORDER BY path",
        )
        .all(project) as MapRow[];
    }
    return ok(rows.map(rowToEntry));
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }
};

export const searchMap = (
  db: Database,
  project: string,
  query: string,
): Result<readonly CodebaseMapEntry[], Error> => {
  try {
    const rows = db
      .prepare(
        `SELECT m.* FROM codebase_map m
         JOIN codebase_map_fts fts ON fts.rowid = m.id
         WHERE m.project = ? AND codebase_map_fts MATCH ?
         ORDER BY rank
         LIMIT 20`,
      )
      .all(project, query) as MapRow[];
    return ok(rows.map(rowToEntry));
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }
};

export const getStaleEntries = (
  db: Database,
  project: string,
  currentHashes: ReadonlyMap<string, string>,
): Result<readonly CodebaseMapEntry[], Error> => {
  try {
    const entries = db
      .prepare("SELECT * FROM codebase_map WHERE project = ? AND type = 'file'")
      .all(project) as MapRow[];

    const stale = entries.filter((row) => {
      const currentHash = currentHashes.get(row.path);
      // File was deleted or hash changed
      return !currentHash || currentHash !== row.file_hash;
    });

    return ok(stale.map(rowToEntry));
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }
};

export const deleteMapEntry = (
  db: Database,
  project: string,
  path: string,
): Result<void, Error> => {
  try {
    db.prepare("DELETE FROM codebase_map WHERE project = ? AND path = ?").run(
      project,
      path,
    );
    return ok(undefined);
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }
};

export const getMapStats = (
  db: Database,
  project: string,
): Result<
  { directories: number; files: number; withSummary: number },
  Error
> => {
  try {
    const dirs = db
      .prepare(
        "SELECT COUNT(*) as count FROM codebase_map WHERE project = ? AND type = 'directory'",
      )
      .get(project) as { count: number };
    const files = db
      .prepare(
        "SELECT COUNT(*) as count FROM codebase_map WHERE project = ? AND type = 'file'",
      )
      .get(project) as { count: number };
    const withSummary = db
      .prepare(
        "SELECT COUNT(*) as count FROM codebase_map WHERE project = ? AND summary IS NOT NULL AND summary != ''",
      )
      .get(project) as { count: number };
    return ok({
      directories: dirs.count,
      files: files.count,
      withSummary: withSummary.count,
    });
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }
};
