/**
 * Database layer for claude-mem.
 * All functions are pure (take db as parameter) for easy testing.
 */

import { Database } from "bun:sqlite";
import type {
	Observation,
	ParsedObservation,
	ParsedSummary,
	Session,
	SessionStatus,
	SessionSummary,
} from "../types/domain";
import { err, ok, type Result } from "../types/result";
import { migrations } from "./migrations";

// ============================================================================
// Database Setup
// ============================================================================

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

// ============================================================================
// Session Operations
// ============================================================================

interface CreateSessionInput {
	readonly claudeSessionId: string;
	readonly project: string;
	readonly userPrompt: string;
}

export interface CreateSessionResult {
	readonly id: number;
	readonly isNew: boolean;
}

/**
 * Creates a new session or returns existing one (idempotent).
 * Returns both the session ID and whether it was newly created.
 */
export const createSession = (
	db: Database,
	input: CreateSessionInput,
): Result<CreateSessionResult> => {
	const { claudeSessionId, project, userPrompt } = input;
	const now = new Date();
	const nowIso = now.toISOString();
	const nowEpoch = now.getTime();

	try {
		// Try to insert new session
		const insertResult = db.run(
			`INSERT OR IGNORE INTO sdk_sessions
       (claude_session_id, project, user_prompt, started_at, started_at_epoch, status)
       VALUES (?, ?, ?, ?, ?, 'active')`,
			[claudeSessionId, project, userPrompt, nowIso, nowEpoch],
		);

		// changes will be 1 if inserted, 0 if ignored (already existed)
		const isNew = insertResult.changes > 0;

		// Get the session (either newly created or existing)
		const row = db
			.query<{ id: number }, [string]>(
				"SELECT id FROM sdk_sessions WHERE claude_session_id = ?",
			)
			.get(claudeSessionId);

		if (!row) {
			return err(new Error("Failed to create or find session"));
		}

		return ok({ id: row.id, isNew });
	} catch (e) {
		return err(e instanceof Error ? e : new Error(String(e)));
	}
};

/**
 * Gets a session by Claude session ID.
 */
export const getSessionByClaudeId = (
	db: Database,
	claudeSessionId: string,
): Result<Session | null> => {
	try {
		const row = db
			.query<SessionRow, [string]>(
				`SELECT id, claude_session_id, sdk_session_id, project, user_prompt,
              started_at, started_at_epoch, completed_at, completed_at_epoch,
              status, prompt_counter
       FROM sdk_sessions WHERE claude_session_id = ?`,
			)
			.get(claudeSessionId);

		if (!row) {
			return ok(null);
		}

		return ok(rowToSession(row));
	} catch (e) {
		return err(e instanceof Error ? e : new Error(String(e)));
	}
};

/**
 * Updates session status.
 */
export const updateSessionStatus = (
	db: Database,
	sessionId: number,
	status: SessionStatus,
): Result<void> => {
	try {
		const now = new Date();
		const completedAt =
			status === "completed" || status === "failed" ? now.toISOString() : null;
		const completedAtEpoch =
			status === "completed" || status === "failed" ? now.getTime() : null;

		db.run(
			`UPDATE sdk_sessions
       SET status = ?, completed_at = ?, completed_at_epoch = ?
       WHERE id = ?`,
			[status, completedAt, completedAtEpoch, sessionId],
		);

		return ok(undefined);
	} catch (e) {
		return err(e instanceof Error ? e : new Error(String(e)));
	}
};

/**
 * Increments prompt counter and returns new value.
 * Uses RETURNING clause for single-query operation (eliminates N+1).
 */
export const incrementPromptCounter = (
	db: Database,
	sessionId: number,
): Result<number> => {
	try {
		const row = db
			.query<{ prompt_counter: number }, [number]>(
				"UPDATE sdk_sessions SET prompt_counter = prompt_counter + 1 WHERE id = ? RETURNING prompt_counter",
			)
			.get(sessionId);

		if (!row) {
			return err(new Error("Session not found"));
		}

		return ok(row.prompt_counter);
	} catch (e) {
		return err(e instanceof Error ? e : new Error(String(e)));
	}
};

// ============================================================================
// Observation Operations
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

	try {
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

		return ok(Number(result.lastInsertRowid));
	} catch (e) {
		return err(e instanceof Error ? e : new Error(String(e)));
	}
};

/**
 * Gets an observation by ID.
 */
export const getObservationById = (
	db: Database,
	id: number,
): Result<Observation | null> => {
	try {
		const row = db
			.query<ObservationRow, [number]>(
				`SELECT * FROM observations WHERE id = ?`,
			)
			.get(id);

		if (!row) {
			return ok(null);
		}

		return ok(rowToObservation(row));
	} catch (e) {
		return err(e instanceof Error ? e : new Error(String(e)));
	}
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

	try {
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

		return ok(rows.map(rowToObservation));
	} catch (e) {
		return err(e instanceof Error ? e : new Error(String(e)));
	}
};

// ============================================================================
// Summary Operations
// ============================================================================

interface StoreSummaryInput {
	readonly claudeSessionId: string;
	readonly project: string;
	readonly summary: ParsedSummary;
	readonly promptNumber: number;
	readonly discoveryTokens?: number;
}

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

	try {
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

		return ok(Number(result.lastInsertRowid));
	} catch (e) {
		return err(e instanceof Error ? e : new Error(String(e)));
	}
};

interface GetRecentSummariesInput {
	readonly project?: string;
	readonly limit: number;
}

/**
 * Gets recent summaries, optionally filtered by project.
 */
export const getRecentSummaries = (
	db: Database,
	input: GetRecentSummariesInput,
): Result<readonly SessionSummary[]> => {
	const { project, limit } = input;

	try {
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

		return ok(rows.map(rowToSummary));
	} catch (e) {
		return err(e instanceof Error ? e : new Error(String(e)));
	}
};

// ============================================================================
// User Prompt Operations
// ============================================================================

interface SaveUserPromptInput {
	readonly claudeSessionId: string;
	readonly promptNumber: number;
	readonly promptText: string;
}

/**
 * Saves a user prompt.
 */
export const saveUserPrompt = (
	db: Database,
	input: SaveUserPromptInput,
): Result<number> => {
	const { claudeSessionId, promptNumber, promptText } = input;
	const now = new Date();

	try {
		const result = db.run(
			`INSERT INTO user_prompts
       (claude_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
       VALUES (?, ?, ?, ?, ?)`,
			[
				claudeSessionId,
				promptNumber,
				promptText,
				now.toISOString(),
				now.getTime(),
			],
		);

		return ok(Number(result.lastInsertRowid));
	} catch (e) {
		return err(e instanceof Error ? e : new Error(String(e)));
	}
};

// ============================================================================
// Search Operations
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

	try {
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

		return ok(rows.map(rowToObservation));
	} catch (e) {
		return err(e instanceof Error ? e : new Error(String(e)));
	}
};

/**
 * Searches summaries using FTS5.
 */
export const searchSummaries = (
	db: Database,
	input: SearchInput,
): Result<readonly SessionSummary[]> => {
	const { query, project, limit } = input;

	try {
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

		return ok(rows.map(rowToSummary));
	} catch (e) {
		return err(e instanceof Error ? e : new Error(String(e)));
	}
};

// ============================================================================
// Row Types and Converters
// ============================================================================

interface SessionRow {
	id: number;
	claude_session_id: string;
	sdk_session_id: string | null;
	project: string;
	user_prompt: string | null;
	started_at: string;
	started_at_epoch: number;
	completed_at: string | null;
	completed_at_epoch: number | null;
	status: string;
	prompt_counter: number;
}

interface ObservationRow {
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
}

interface SummaryRow {
	id: number;
	sdk_session_id: string;
	project: string;
	request: string | null;
	investigated: string | null;
	learned: string | null;
	completed: string | null;
	next_steps: string | null;
	notes: string | null;
	prompt_number: number;
	discovery_tokens: number;
	created_at: string;
	created_at_epoch: number;
}

const rowToSession = (row: SessionRow): Session => ({
	id: row.id,
	claudeSessionId: row.claude_session_id,
	sdkSessionId: row.sdk_session_id,
	project: row.project,
	userPrompt: row.user_prompt,
	startedAt: row.started_at,
	startedAtEpoch: row.started_at_epoch,
	completedAt: row.completed_at,
	completedAtEpoch: row.completed_at_epoch,
	status: row.status as SessionStatus,
	promptCounter: row.prompt_counter,
});

const parseJsonArray = (json: string | null): readonly string[] => {
	if (!json) return [];
	try {
		const parsed = JSON.parse(json);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
};

const rowToObservation = (row: ObservationRow): Observation => ({
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
});

const rowToSummary = (row: SummaryRow): SessionSummary => ({
	id: row.id,
	sdkSessionId: row.sdk_session_id,
	project: row.project,
	request: row.request,
	investigated: row.investigated,
	learned: row.learned,
	completed: row.completed,
	nextSteps: row.next_steps,
	notes: row.notes,
	promptNumber: row.prompt_number,
	discoveryTokens: row.discovery_tokens,
	createdAt: row.created_at,
	createdAtEpoch: row.created_at_epoch,
});
