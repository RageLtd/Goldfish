/**
 * Session CRUD operations.
 */

import type { Database } from "bun:sqlite";
import type { Session, SessionStatus } from "../types/domain";
import { err, flatMap, fromTry, ok, type Result } from "../types/result";
import { rowToSession, type SessionRow } from "./converters";

// ============================================================================
// Types
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

// ============================================================================
// Operations
// ============================================================================

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

  return flatMap(
    fromTry(() => {
      const insertResult = db.run(
        `INSERT OR IGNORE INTO sdk_sessions
       (claude_session_id, project, user_prompt, started_at, started_at_epoch, status)
       VALUES (?, ?, ?, ?, ?, 'active')`,
        [claudeSessionId, project, userPrompt, nowIso, nowEpoch],
      );

      const isNew = insertResult.changes > 0;

      const row = db
        .query<{ id: number }, [string]>(
          "SELECT id FROM sdk_sessions WHERE claude_session_id = ?",
        )
        .get(claudeSessionId);

      return { row, isNew };
    }),
    ({ row, isNew }) => {
      if (!row) {
        return err(new Error("Failed to create or find session"));
      }
      return ok({ id: row.id, isNew });
    },
  );
};

/**
 * Gets a session by Claude session ID.
 */
export const getSessionByClaudeId = (
  db: Database,
  claudeSessionId: string,
): Result<Session | null> => {
  return fromTry(() => {
    const row = db
      .query<SessionRow, [string]>(
        `SELECT id, claude_session_id, sdk_session_id, project, user_prompt,
              started_at, started_at_epoch, completed_at, completed_at_epoch,
              status, prompt_counter
       FROM sdk_sessions WHERE claude_session_id = ?`,
      )
      .get(claudeSessionId);

    if (!row) {
      return null;
    }

    return rowToSession(row);
  });
};

/**
 * Updates session status.
 */
export const updateSessionStatus = (
  db: Database,
  sessionId: number,
  status: SessionStatus,
): Result<void> => {
  return fromTry(() => {
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
  });
};

/**
 * Increments prompt counter and returns new value.
 * Uses RETURNING clause for single-query operation (eliminates N+1).
 */
export const incrementPromptCounter = (
  db: Database,
  sessionId: number,
): Result<number> => {
  return flatMap(
    fromTry(() =>
      db
        .query<{ prompt_counter: number }, [number]>(
          "UPDATE sdk_sessions SET prompt_counter = prompt_counter + 1 WHERE id = ? RETURNING prompt_counter",
        )
        .get(sessionId),
    ),
    (row) => {
      if (!row) {
        return err(new Error("Session not found"));
      }
      return ok(row.prompt_counter);
    },
  );
};
