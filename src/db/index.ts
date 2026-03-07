/**
 * Database layer for goldfish.
 * Barrel re-exports from all submodules.
 */

export {
  type EdgeRow,
  type ObservationRow,
  parseJsonArray,
  parseJsonObject,
  rowToEdge,
  rowToObservation,
  rowToSession,
  rowToSummary,
  type SessionRow,
  type SummaryRow,
} from "./converters";
export {
  deleteEdgesByObservation,
  getAllEdges,
  getEdgesBetween,
  getEdgesByObservation,
  storeEdge,
  updateObservationGraphMetadata,
} from "./edges";
export {
  deleteObservationsByIds,
  findSimilarObservation,
  getCandidateObservations,
  getEmbeddingsByIds,
  getObservationById,
  getObservationsForPruning,
  getObservationsWithEmbeddings,
  getObservationsWithEmbeddingsButNoEdges,
  getObservationsWithoutEmbeddings,
  getRecentObservations,
  jaccardSimilarity,
  type ObservationWithRank,
  type PruneCandidate,
  searchObservationIds,
  searchObservations,
  storeObservation,
  updateObservationEmbedding,
} from "./observations";
export {
  type CreateSessionResult,
  createSession,
  getSessionByClaudeId,
  incrementPromptCounter,
  updateSessionStatus,
} from "./sessions";
export { createDatabase, runMigrations } from "./setup";
export {
  getRecentSummaries,
  searchSummaries,
  storeSummary,
} from "./summaries";
