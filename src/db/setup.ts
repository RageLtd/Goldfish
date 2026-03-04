/**
 * Database creation and migration setup.
 */

import { Database } from "bun:sqlite";
import { migrations } from "./migrations";

/**
 * Creates a new database connection with optimal settings.
 */
export const createDatabase = (path: string): Database => {
  const db = new Database(path);

  // Enable WAL mode for better concurrency
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA synchronous = NORMAL");
  db.run("PRAGMA cache_size = -64000"); // 64MB cache
  db.run("PRAGMA temp_store = MEMORY");
  db.run("PRAGMA foreign_keys = ON");

  return db;
};

/**
 * Runs all pending migrations.
 */
export const runMigrations = (db: Database): void => {
  // Create migrations table
  db.run(`
    CREATE TABLE IF NOT EXISTS migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);

  // Get current version
  const current = db
    .query<{ v: number | null }, []>("SELECT MAX(version) as v FROM migrations")
    .get();
  const currentVersion = current?.v ?? 0;

  // Apply pending migrations
  for (const migration of migrations) {
    if (migration.version > currentVersion) {
      migration.up(db);
      db.run("INSERT INTO migrations (version, applied_at) VALUES (?, ?)", [
        migration.version,
        new Date().toISOString(),
      ]);
    }
  }
};
