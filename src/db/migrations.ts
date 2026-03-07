/**
 * Database migrations for goldfish.
 * Each migration is a pure function that takes a database and applies changes.
 */

import type { Database } from "bun:sqlite";

export interface Migration {
  readonly version: number;
  readonly description: string;
  readonly up: (db: Database) => void;
}

export const migrations: readonly Migration[] = [
  {
    version: 1,
    description: "Create core tables",
    up: (db) => {
      db.run(`
        CREATE TABLE IF NOT EXISTS sdk_sessions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          claude_session_id TEXT UNIQUE NOT NULL,
          sdk_session_id TEXT UNIQUE,
          project TEXT NOT NULL,
          user_prompt TEXT,
          started_at TEXT NOT NULL,
          started_at_epoch INTEGER NOT NULL,
          completed_at TEXT,
          completed_at_epoch INTEGER,
          status TEXT CHECK(status IN ('active', 'completed', 'failed')) NOT NULL DEFAULT 'active',
          prompt_counter INTEGER DEFAULT 1
        )
      `);

      db.run(`
        CREATE TABLE IF NOT EXISTS observations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          sdk_session_id TEXT NOT NULL,
          project TEXT NOT NULL,
          type TEXT NOT NULL CHECK(type IN ('decision', 'bugfix', 'feature', 'refactor', 'discovery', 'change')),
          title TEXT,
          subtitle TEXT,
          narrative TEXT,
          facts TEXT,
          concepts TEXT,
          files_read TEXT,
          files_modified TEXT,
          prompt_number INTEGER,
          discovery_tokens INTEGER DEFAULT 0,
          created_at TEXT NOT NULL,
          created_at_epoch INTEGER NOT NULL,
          FOREIGN KEY(sdk_session_id) REFERENCES sdk_sessions(claude_session_id) ON DELETE CASCADE
        )
      `);

      db.run(`
        CREATE TABLE IF NOT EXISTS session_summaries (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          sdk_session_id TEXT NOT NULL,
          project TEXT NOT NULL,
          request TEXT,
          investigated TEXT,
          learned TEXT,
          completed TEXT,
          next_steps TEXT,
          notes TEXT,
          prompt_number INTEGER,
          discovery_tokens INTEGER DEFAULT 0,
          created_at TEXT NOT NULL,
          created_at_epoch INTEGER NOT NULL,
          FOREIGN KEY(sdk_session_id) REFERENCES sdk_sessions(claude_session_id) ON DELETE CASCADE
        )
      `);

      db.run(`
        CREATE TABLE IF NOT EXISTS user_prompts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          claude_session_id TEXT NOT NULL,
          prompt_number INTEGER NOT NULL,
          prompt_text TEXT NOT NULL,
          created_at TEXT NOT NULL,
          created_at_epoch INTEGER NOT NULL,
          FOREIGN KEY(claude_session_id) REFERENCES sdk_sessions(claude_session_id) ON DELETE CASCADE
        )
      `);
    },
  },
  {
    version: 2,
    description: "Create indexes",
    up: (db) => {
      db.run(
        "CREATE INDEX IF NOT EXISTS idx_sdk_sessions_claude_id ON sdk_sessions(claude_session_id)",
      );
      db.run(
        "CREATE INDEX IF NOT EXISTS idx_sdk_sessions_project ON sdk_sessions(project)",
      );
      db.run(
        "CREATE INDEX IF NOT EXISTS idx_sdk_sessions_status ON sdk_sessions(status)",
      );
      db.run(
        "CREATE INDEX IF NOT EXISTS idx_sdk_sessions_started ON sdk_sessions(started_at_epoch DESC)",
      );

      db.run(
        "CREATE INDEX IF NOT EXISTS idx_observations_sdk_session ON observations(sdk_session_id)",
      );
      db.run(
        "CREATE INDEX IF NOT EXISTS idx_observations_project ON observations(project)",
      );
      db.run(
        "CREATE INDEX IF NOT EXISTS idx_observations_type ON observations(type)",
      );
      db.run(
        "CREATE INDEX IF NOT EXISTS idx_observations_created ON observations(created_at_epoch DESC)",
      );

      db.run(
        "CREATE INDEX IF NOT EXISTS idx_session_summaries_sdk_session ON session_summaries(sdk_session_id)",
      );
      db.run(
        "CREATE INDEX IF NOT EXISTS idx_session_summaries_project ON session_summaries(project)",
      );
      db.run(
        "CREATE INDEX IF NOT EXISTS idx_session_summaries_created ON session_summaries(created_at_epoch DESC)",
      );

      db.run(
        "CREATE INDEX IF NOT EXISTS idx_user_prompts_claude_session ON user_prompts(claude_session_id)",
      );
      db.run(
        "CREATE INDEX IF NOT EXISTS idx_user_prompts_created ON user_prompts(created_at_epoch DESC)",
      );
    },
  },
  {
    version: 3,
    description: "Create FTS5 tables for full-text search",
    up: (db) => {
      // Observations FTS
      db.run(`
        CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
          title,
          subtitle,
          narrative,
          facts,
          concepts,
          content='observations',
          content_rowid='id'
        )
      `);

      // Session summaries FTS
      db.run(`
        CREATE VIRTUAL TABLE IF NOT EXISTS session_summaries_fts USING fts5(
          request,
          investigated,
          learned,
          completed,
          next_steps,
          notes,
          content='session_summaries',
          content_rowid='id'
        )
      `);

      // User prompts FTS
      db.run(`
        CREATE VIRTUAL TABLE IF NOT EXISTS user_prompts_fts USING fts5(
          prompt_text,
          content='user_prompts',
          content_rowid='id'
        )
      `);
    },
  },
  {
    version: 4,
    description: "Create FTS triggers for automatic sync",
    up: (db) => {
      // Observations triggers
      db.run(`
        CREATE TRIGGER IF NOT EXISTS observations_ai AFTER INSERT ON observations BEGIN
          INSERT INTO observations_fts(rowid, title, subtitle, narrative, facts, concepts)
          VALUES (new.id, new.title, new.subtitle, new.narrative, new.facts, new.concepts);
        END
      `);

      db.run(`
        CREATE TRIGGER IF NOT EXISTS observations_ad AFTER DELETE ON observations BEGIN
          INSERT INTO observations_fts(observations_fts, rowid, title, subtitle, narrative, facts, concepts)
          VALUES ('delete', old.id, old.title, old.subtitle, old.narrative, old.facts, old.concepts);
        END
      `);

      db.run(`
        CREATE TRIGGER IF NOT EXISTS observations_au AFTER UPDATE ON observations BEGIN
          INSERT INTO observations_fts(observations_fts, rowid, title, subtitle, narrative, facts, concepts)
          VALUES ('delete', old.id, old.title, old.subtitle, old.narrative, old.facts, old.concepts);
          INSERT INTO observations_fts(rowid, title, subtitle, narrative, facts, concepts)
          VALUES (new.id, new.title, new.subtitle, new.narrative, new.facts, new.concepts);
        END
      `);

      // Session summaries triggers
      db.run(`
        CREATE TRIGGER IF NOT EXISTS session_summaries_ai AFTER INSERT ON session_summaries BEGIN
          INSERT INTO session_summaries_fts(rowid, request, investigated, learned, completed, next_steps, notes)
          VALUES (new.id, new.request, new.investigated, new.learned, new.completed, new.next_steps, new.notes);
        END
      `);

      db.run(`
        CREATE TRIGGER IF NOT EXISTS session_summaries_ad AFTER DELETE ON session_summaries BEGIN
          INSERT INTO session_summaries_fts(session_summaries_fts, rowid, request, investigated, learned, completed, next_steps, notes)
          VALUES ('delete', old.id, old.request, old.investigated, old.learned, old.completed, old.next_steps, old.notes);
        END
      `);

      // User prompts triggers
      db.run(`
        CREATE TRIGGER IF NOT EXISTS user_prompts_ai AFTER INSERT ON user_prompts BEGIN
          INSERT INTO user_prompts_fts(rowid, prompt_text)
          VALUES (new.id, new.prompt_text);
        END
      `);

      db.run(`
        CREATE TRIGGER IF NOT EXISTS user_prompts_ad AFTER DELETE ON user_prompts BEGIN
          INSERT INTO user_prompts_fts(user_prompts_fts, rowid, prompt_text)
          VALUES ('delete', old.id, old.prompt_text);
        END
      `);
    },
  },
  {
    version: 5,
    description: "Add cross-project query indexes",
    up: (db) => {
      db.run(
        "CREATE INDEX IF NOT EXISTS idx_observations_concepts ON observations(concepts)",
      );
      db.run(
        "CREATE INDEX IF NOT EXISTS idx_observations_project_epoch ON observations(project, created_at_epoch DESC)",
      );
    },
  },
  {
    version: 6,
    description: "Add embedding column to observations",
    up: (db) => {
      db.run("ALTER TABLE observations ADD COLUMN embedding BLOB");
    },
  },
  {
    version: 7,
    description: "Drop unused user_prompts table",
    up: (db) => {
      db.run("DROP TRIGGER IF EXISTS user_prompts_ai");
      db.run("DROP TRIGGER IF EXISTS user_prompts_ad");
      db.run("DROP TABLE IF EXISTS user_prompts_fts");
      db.run("DROP INDEX IF EXISTS idx_user_prompts_claude_session");
      db.run("DROP INDEX IF EXISTS idx_user_prompts_created");
      db.run("DROP TABLE IF EXISTS user_prompts");
    },
  },
  {
    version: 8,
    description: "Create knowledge graph edges table",
    up: (db) => {
      db.run(`
        CREATE TABLE IF NOT EXISTS kg_edges (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id INTEGER NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
          target_id INTEGER NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
          relation TEXT NOT NULL,
          weight REAL NOT NULL DEFAULT 1.0,
          direction TEXT NOT NULL DEFAULT 'directed',
          explanation TEXT,
          metadata TEXT,
          created_at_epoch INTEGER NOT NULL,
          UNIQUE(source_id, target_id, relation)
        )
      `);

      db.run(
        "CREATE INDEX IF NOT EXISTS idx_kg_edges_source ON kg_edges(source_id)",
      );
      db.run(
        "CREATE INDEX IF NOT EXISTS idx_kg_edges_target ON kg_edges(target_id)",
      );
      db.run(
        "CREATE INDEX IF NOT EXISTS idx_kg_edges_relation ON kg_edges(relation)",
      );
    },
  },
  {
    version: 9,
    description: "Add precomputed graph metadata to observations",
    up: (db) => {
      db.run("ALTER TABLE observations ADD COLUMN graph_centrality REAL");
      db.run("ALTER TABLE observations ADD COLUMN graph_community INTEGER");
      db.run(
        "ALTER TABLE observations ADD COLUMN graph_degree INTEGER DEFAULT 0",
      );
    },
  },
  {
    version: 10,
    description:
      "Deduplicate bidirectional edges and normalize source_id < target_id",
    up: (db) => {
      // Delete duplicate bidirectional edges where the reverse also exists.
      db.run(`
        DELETE FROM kg_edges
        WHERE direction = 'bidirectional'
          AND source_id > target_id
          AND EXISTS (
            SELECT 1 FROM kg_edges e2
            WHERE e2.source_id = kg_edges.target_id
              AND e2.target_id = kg_edges.source_id
              AND e2.relation = kg_edges.relation
              AND e2.direction = 'bidirectional'
          )
      `);

      // Normalize remaining bidirectional edges where source_id > target_id
      db.run(`
        CREATE TEMP TABLE edges_to_flip AS
        SELECT id, target_id AS new_source, source_id AS new_target
        FROM kg_edges
        WHERE direction = 'bidirectional' AND source_id > target_id
      `);

      db.run(`
        UPDATE kg_edges
        SET source_id = (SELECT new_source FROM edges_to_flip WHERE edges_to_flip.id = kg_edges.id),
            target_id = (SELECT new_target FROM edges_to_flip WHERE edges_to_flip.id = kg_edges.id)
        WHERE id IN (SELECT id FROM edges_to_flip)
      `);

      db.run("DROP TABLE IF EXISTS edges_to_flip");
    },
  },
  {
    version: 11,
    description: "Create codebase map tables",
    up: (db) => {
      db.run(`
        CREATE TABLE IF NOT EXISTS codebase_map (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project TEXT NOT NULL,
          path TEXT NOT NULL,
          type TEXT NOT NULL CHECK(type IN ('directory', 'file')),
          summary TEXT,
          file_hash TEXT,
          last_scanned_epoch INTEGER NOT NULL,
          UNIQUE(project, path)
        )
      `);

      db.run(
        "CREATE INDEX IF NOT EXISTS idx_codebase_map_project ON codebase_map(project)",
      );
      db.run(
        "CREATE INDEX IF NOT EXISTS idx_codebase_map_type ON codebase_map(project, type)",
      );

      db.run(`
        CREATE VIRTUAL TABLE IF NOT EXISTS codebase_map_fts USING fts5(
          path,
          summary,
          content='codebase_map',
          content_rowid='id'
        )
      `);

      db.run(`
        CREATE TRIGGER IF NOT EXISTS codebase_map_ai AFTER INSERT ON codebase_map BEGIN
          INSERT INTO codebase_map_fts(rowid, path, summary)
          VALUES (new.id, new.path, new.summary);
        END
      `);

      db.run(`
        CREATE TRIGGER IF NOT EXISTS codebase_map_ad AFTER DELETE ON codebase_map BEGIN
          INSERT INTO codebase_map_fts(codebase_map_fts, rowid, path, summary)
          VALUES ('delete', old.id, old.path, old.summary);
        END
      `);

      db.run(`
        CREATE TRIGGER IF NOT EXISTS codebase_map_au AFTER UPDATE ON codebase_map BEGIN
          INSERT INTO codebase_map_fts(codebase_map_fts, rowid, path, summary)
          VALUES ('delete', old.id, old.path, old.summary);
          INSERT INTO codebase_map_fts(rowid, path, summary)
          VALUES (new.id, new.path, new.summary);
        END
      `);
    },
  },
];
