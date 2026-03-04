/**
 * Barrel re-exports for worker handlers.
 */

export {
  handleBackfill,
  handleBackfillStatus,
  handleHealth,
  handleShutdown,
} from "./admin";
export {
  handleGetNeighbors,
  handleGraphBackfill,
  handleGraphStats,
} from "./graph";
export {
  handleGetContext,
  handleGetObservation,
  handleRetrieve,
} from "./retrieval";
export {
  handleFindByFile,
  handleGetDecisions,
  handleGetTimeline,
  handleSearch,
} from "./search";
export {
  handleCompleteSession,
  handleQueueObservation,
  handleQueueSummary,
} from "./session";
export type {
  CompleteSessionInput,
  ContextFormat,
  DecisionsInput,
  FindByFileInput,
  GetContextInput,
  GetObservationInput,
  GraphNeighborsInput,
  HandlerResponse,
  HealthCheckResponse,
  QueueObservationInput,
  QueueSummaryInput,
  RetrieveInput,
  SearchInput,
  TimelineInput,
  WorkerDeps,
} from "./types";
export { enqueueMissingEmbeddings } from "./types";
