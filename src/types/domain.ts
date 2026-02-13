/**
 * Core domain types for claude-mem.
 * All types are immutable (readonly) and represent the business domain.
 */

// ============================================================================
// Observation Types
// ============================================================================

export const OBSERVATION_TYPES = [
  "decision",
  "bugfix",
  "feature",
  "refactor",
  "discovery",
  "change",
] as const;

export type ObservationType = (typeof OBSERVATION_TYPES)[number];

export const isObservationType = (value: string): value is ObservationType =>
  OBSERVATION_TYPES.includes(value as ObservationType);

// ============================================================================
// Concept Tags
// ============================================================================

export const CONCEPT_TAGS = [
  "how-it-works",
  "why-it-exists",
  "what-changed",
  "problem-solution",
  "gotcha",
  "pattern",
  "trade-off",
] as const;

export type ConceptTag = (typeof CONCEPT_TAGS)[number];

// ============================================================================
// Session Status
// ============================================================================

export const SESSION_STATUSES = ["active", "completed", "failed"] as const;

export type SessionStatus = (typeof SESSION_STATUSES)[number];

// ============================================================================
// Parsed Data (from SDK Agent XML output)
// ============================================================================

export interface ParsedObservation {
  readonly type: ObservationType;
  readonly title: string | null;
  readonly subtitle: string | null;
  readonly narrative: string | null;
  readonly facts: readonly string[];
  readonly concepts: readonly string[];
  readonly filesRead: readonly string[];
  readonly filesModified: readonly string[];
}

export interface ParsedSummary {
  readonly request: string | null;
  readonly investigated: string | null;
  readonly learned: string | null;
  readonly completed: string | null;
  readonly nextSteps: string | null;
  readonly notes: string | null;
}

// ============================================================================
// Database Entities (what's stored)
// ============================================================================

export interface Session {
  readonly id: number;
  readonly claudeSessionId: string;
  readonly sdkSessionId: string | null;
  readonly project: string;
  readonly userPrompt: string | null;
  readonly startedAt: string;
  readonly startedAtEpoch: number;
  readonly completedAt: string | null;
  readonly completedAtEpoch: number | null;
  readonly status: SessionStatus;
  readonly promptCounter: number;
}

export interface Observation {
  readonly id: number;
  readonly sdkSessionId: string;
  readonly project: string;
  readonly type: ObservationType;
  readonly title: string | null;
  readonly subtitle: string | null;
  readonly narrative: string | null;
  readonly facts: readonly string[];
  readonly concepts: readonly string[];
  readonly filesRead: readonly string[];
  readonly filesModified: readonly string[];
  readonly promptNumber: number;
  readonly discoveryTokens: number;
  readonly createdAt: string;
  readonly createdAtEpoch: number;
}

export interface SessionSummary {
  readonly id: number;
  readonly sdkSessionId: string;
  readonly project: string;
  readonly request: string | null;
  readonly investigated: string | null;
  readonly learned: string | null;
  readonly completed: string | null;
  readonly nextSteps: string | null;
  readonly notes: string | null;
  readonly promptNumber: number;
  readonly discoveryTokens: number;
  readonly createdAt: string;
  readonly createdAtEpoch: number;
}

export interface UserPrompt {
  readonly id: number;
  readonly claudeSessionId: string;
  readonly promptNumber: number;
  readonly promptText: string;
  readonly createdAt: string;
  readonly createdAtEpoch: number;
}

// ============================================================================
// Tool Observation (raw input from hooks)
// ============================================================================

export interface ToolObservation {
  readonly toolName: string;
  readonly toolInput: unknown;
  readonly toolResponse: unknown;
  readonly cwd: string;
  readonly occurredAt: string;
}

// ============================================================================
// Search Results
// ============================================================================

export interface ObservationSearchResult extends Observation {
  readonly rank?: number;
}

export interface SessionSearchResult extends SessionSummary {
  readonly rank?: number;
}

export interface UserPromptSearchResult extends UserPrompt {
  readonly rank?: number;
}

// ============================================================================
// Timeline
// ============================================================================

export type TimelineItem =
  | { readonly kind: "observation"; readonly data: Observation }
  | { readonly kind: "summary"; readonly data: SessionSummary };

// ============================================================================
// Context Injection
// ============================================================================

export interface InjectedContext {
  readonly observations: readonly Observation[];
  readonly summaries: readonly SessionSummary[];
  readonly formatted: string;
}
