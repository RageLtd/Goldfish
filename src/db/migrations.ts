/**
 * Database migrations for claude-mem.
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
];
