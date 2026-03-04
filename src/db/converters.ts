/**
 * Row types and converters for mapping SQLite rows to domain types.
 * Shared across all db submodules.
 */

import type {
  EdgeDirection,
  EdgeRelationType,
  KnowledgeGraphEdge,
  Observation,
  Session,
  SessionStatus,
  SessionSummary,
} from "../types/domain";
import { fromTry } from "../types/result";

// ============================================================================
// Row Types
// ============================================================================

export interface SessionRow {
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

export interface ObservationRow {
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
  embedding: Buffer | null;
}

export interface SummaryRow {
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

export interface EdgeRow {
  id: number;
  source_id: number;
  target_id: number;
  relation: string;
  weight: number;
  direction: string;
  explanation: string | null;
  metadata: string | null;
  created_at_epoch: number;
}

// ============================================================================
// Converters
// ============================================================================

export const rowToSession = (row: SessionRow): Session => ({
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

export const parseJsonArray = (json: string | null): readonly string[] => {
  if (!json) return [];
  const result = fromTry(() => JSON.parse(json));
  if (!result.ok) return [];
  return Array.isArray(result.value) ? result.value : [];
};

export const rowToObservation = (row: ObservationRow): Observation => ({
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

export const rowToSummary = (row: SummaryRow): SessionSummary => ({
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

export const parseJsonObject = (
  json: string | null,
): Record<string, unknown> | null => {
  if (!json) return null;
  const result = fromTry(() => JSON.parse(json));
  if (!result.ok) return null;
  return typeof result.value === "object" && !Array.isArray(result.value)
    ? result.value
    : null;
};

export const rowToEdge = (row: EdgeRow): KnowledgeGraphEdge => ({
  id: row.id,
  sourceId: row.source_id,
  targetId: row.target_id,
  relation: row.relation as EdgeRelationType,
  weight: row.weight,
  direction: row.direction as EdgeDirection,
  explanation: row.explanation,
  metadata: parseJsonObject(row.metadata),
  createdAtEpoch: row.created_at_epoch,
});
