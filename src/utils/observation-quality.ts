/**
 * Pure quality-check module for observations.
 * No DB dependency — takes an Observation and returns quality signals.
 */

import type { Observation } from "../types/domain";

export const LOW_VALUE_REASONS = [
  "missing-title",
  "missing-narrative",
  "too-short",
  "empty-change",
  "no-references",
] as const;

export type LowValueReason = (typeof LOW_VALUE_REASONS)[number];

export const MIN_CONTENT_LENGTH = 20;

const isBlank = (s: string | null): boolean => !s || s.trim().length === 0;

/**
 * Returns all reasons an observation is considered low-value.
 * Empty array means the observation is worth keeping.
 */
export const getLowValueReasons = (
  obs: Observation,
): readonly LowValueReason[] => {
  const reasons: LowValueReason[] = [];

  if (isBlank(obs.title)) {
    reasons.push("missing-title");
  }

  if (isBlank(obs.narrative)) {
    reasons.push("missing-narrative");
  }

  const combinedLength =
    (obs.title?.trim().length ?? 0) + (obs.narrative?.trim().length ?? 0);
  if (combinedLength < MIN_CONTENT_LENGTH) {
    reasons.push("too-short");
  }

  if (
    obs.type === "change" &&
    obs.filesRead.length === 0 &&
    obs.filesModified.length === 0 &&
    obs.facts.length === 0
  ) {
    reasons.push("empty-change");
  }

  if (
    !isBlank(obs.title) &&
    obs.filesRead.length === 0 &&
    obs.filesModified.length === 0 &&
    obs.facts.length === 0
  ) {
    reasons.push("no-references");
  }

  return reasons;
};

/**
 * Convenience predicate — true when the observation has at least one low-value reason.
 */
export const isLowValueObservation = (obs: Observation): boolean =>
  getLowValueReasons(obs).length > 0;
