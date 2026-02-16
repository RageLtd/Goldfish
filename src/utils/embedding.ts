/**
 * Shared embedding utilities.
 */

/**
 * Builds the text used for embedding computation from observation fields.
 * Single source of truth — used by local-agent, message-router, and backfill.
 */
export const buildEmbeddingText = (observation: {
  readonly title: string | null;
  readonly narrative: string | null;
}): string => {
  return `${observation.title ?? ""} ${observation.narrative ?? ""}`.trim();
};
