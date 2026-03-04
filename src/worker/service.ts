/**
 * Worker HTTP service router.
 * Pure functional router that maps requests to handlers.
 */

import { fromTry } from "../types/result";
import { sanitizeLimit, sanitizeProject } from "../utils/validation";
import {
  type CompleteSessionInput,
  type ContextFormat,
  handleBackfill,
  handleBackfillStatus,
  handleCompleteSession,
  handleFindByFile,
  handleGetContext,
  handleGetDecisions,
  handleGetNeighbors,
  handleGetObservation,
  handleGetTimeline,
  handleGraphBackfill,
  handleGraphStats,
  handleHealth,
  handleQueueObservation,
  handleQueueSummary,
  handleRetrieve,
  handleSearch,
  handleShutdown,
  type QueueObservationInput,
  type QueueSummaryInput,
  type RetrieveInput,
  type WorkerDeps,
} from "./handlers";

// ============================================================================
// Types
// ============================================================================

export interface WorkerRouter {
  readonly handle: (request: Request) => Promise<Response>;
}

interface Route {
  readonly method: string;
  readonly path: string;
  readonly handler: (deps: WorkerDeps, request: Request) => Promise<Response>;
}

// ============================================================================
// Helper Functions
// ============================================================================

const jsonResponse = (status: number, body: unknown): Response => {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
};

/**
 * Parses JSON body from request.
 * Returns null for empty or invalid JSON, allowing callers to return 400.
 */
const parseJsonBody = async <T>(request: Request): Promise<T | null> => {
  const text = await request.text();
  if (!text.trim()) {
    return null;
  }
  const result = fromTry(() => JSON.parse(text) as T);
  return result.ok ? result.value : null;
};

const getSearchParams = (request: Request): URLSearchParams => {
  const url = new URL(request.url);
  return url.searchParams;
};

/**
 * Parses format parameter, defaulting to "index" for progressive disclosure.
 */
const parseFormat = (param: string | null): ContextFormat => {
  return param === "full" ? "full" : "index";
};

// ============================================================================
// Route Handlers
// ============================================================================

const handleHealthRoute = async (
  deps: WorkerDeps,
  _request: Request,
): Promise<Response> => {
  const result = await handleHealth(deps);
  return jsonResponse(result.status, result.body);
};

const handleObservationRoute = async (
  deps: WorkerDeps,
  request: Request,
): Promise<Response> => {
  const body = await parseJsonBody<QueueObservationInput>(request);
  if (!body) {
    return jsonResponse(400, { error: "Invalid JSON body" });
  }

  const result = await handleQueueObservation(deps, {
    claudeSessionId: body.claudeSessionId || "",
    toolName: body.toolName || "",
    toolInput: body.toolInput,
    toolResponse: body.toolResponse,
    cwd: body.cwd || "",
  });

  return jsonResponse(result.status, result.body);
};

const handleSummaryRoute = async (
  deps: WorkerDeps,
  request: Request,
): Promise<Response> => {
  const body = await parseJsonBody<QueueSummaryInput>(request);
  if (!body) {
    return jsonResponse(400, { error: "Invalid JSON body" });
  }

  const result = await handleQueueSummary(deps, {
    claudeSessionId: body.claudeSessionId || "",
    lastUserMessage: body.lastUserMessage || "",
    lastAssistantMessage: body.lastAssistantMessage || "",
    transcriptPath: body.transcriptPath,
  });

  return jsonResponse(result.status, result.body);
};

const handleRetrieveRoute = async (
  deps: WorkerDeps,
  request: Request,
): Promise<Response> => {
  const body = await parseJsonBody<RetrieveInput>(request);
  if (!body) {
    return jsonResponse(400, { error: "Invalid JSON body" });
  }

  const result = await handleRetrieve(deps, {
    prompt: body.prompt || "",
    project: body.project ? sanitizeProject(body.project) : "unknown",
    limit: body.limit || 20,
    sessionId: body.sessionId,
  });

  return jsonResponse(result.status, result.body);
};

const handleCompleteRoute = async (
  deps: WorkerDeps,
  request: Request,
): Promise<Response> => {
  const body = await parseJsonBody<CompleteSessionInput>(request);
  if (!body) {
    return jsonResponse(400, { error: "Invalid JSON body" });
  }

  const result = await handleCompleteSession(deps, {
    claudeSessionId: body.claudeSessionId || "",
    reason: body.reason || "",
  });

  return jsonResponse(result.status, result.body);
};

const handleContextRoute = async (
  deps: WorkerDeps,
  request: Request,
): Promise<Response> => {
  const params = getSearchParams(request);
  const rawProject = params.get("project");
  const limit = sanitizeLimit(params.get("limit"));
  const format = parseFormat(params.get("format"));
  const since = params.get("since") || undefined;

  if (!rawProject) {
    return jsonResponse(400, { error: "project parameter is required" });
  }

  const project = sanitizeProject(rawProject);
  const result = await handleGetContext(deps, {
    project,
    limit,
    format,
    since,
  });
  return jsonResponse(result.status, result.body);
};

const handleSearchRoute = async (
  deps: WorkerDeps,
  request: Request,
): Promise<Response> => {
  const params = getSearchParams(request);
  const query = params.get("query");
  const type = params.get("type") as "observations" | "summaries";
  const concept = params.get("concept") || undefined;
  const rawProject = params.get("project");
  const project = rawProject ? sanitizeProject(rawProject) : undefined;
  const limit = sanitizeLimit(params.get("limit"));

  if (!query) {
    return jsonResponse(400, { error: "query parameter is required" });
  }

  if (!type || (type !== "observations" && type !== "summaries")) {
    return jsonResponse(400, {
      error: "type parameter must be 'observations' or 'summaries'",
    });
  }

  const result = await handleSearch(deps, {
    query,
    type,
    concept,
    project,
    limit,
  });
  return jsonResponse(result.status, result.body);
};

const handleTimelineRoute = async (
  deps: WorkerDeps,
  request: Request,
): Promise<Response> => {
  const params = getSearchParams(request);
  const rawProject = params.get("project");
  const project = rawProject ? sanitizeProject(rawProject) : undefined;
  const limit = sanitizeLimit(params.get("limit"));
  const since = params.get("since") || undefined;

  const result = await handleGetTimeline(deps, {
    project,
    limit,
    since,
  });
  return jsonResponse(result.status, result.body);
};

const handleDecisionsRoute = async (
  deps: WorkerDeps,
  request: Request,
): Promise<Response> => {
  const params = getSearchParams(request);
  const rawProject = params.get("project");
  const project = rawProject ? sanitizeProject(rawProject) : undefined;
  const limit = sanitizeLimit(params.get("limit"));
  const since = params.get("since") || undefined;

  const result = await handleGetDecisions(deps, {
    project,
    limit,
    since,
  });
  return jsonResponse(result.status, result.body);
};

const handleFindByFileRoute = async (
  deps: WorkerDeps,
  request: Request,
): Promise<Response> => {
  const params = getSearchParams(request);
  const file = params.get("file");
  const limit = sanitizeLimit(params.get("limit"));

  if (!file) {
    return jsonResponse(400, { error: "file parameter is required" });
  }

  const result = await handleFindByFile(deps, { file, limit });
  return jsonResponse(result.status, result.body);
};

const handleBackfillRoute = async (
  deps: WorkerDeps,
  _request: Request,
): Promise<Response> => {
  const result = await handleBackfill(deps);
  return jsonResponse(result.status, result.body);
};

const handleBackfillStatusRoute = async (
  deps: WorkerDeps,
  _request: Request,
): Promise<Response> => {
  const result = await handleBackfillStatus(deps);
  return jsonResponse(result.status, result.body);
};

const handleObservationByIdRoute = async (
  deps: WorkerDeps,
  request: Request,
): Promise<Response> => {
  const params = getSearchParams(request);
  const idParam = params.get("id");
  const id = idParam ? parseInt(idParam, 10) : 0;

  if (!id || Number.isNaN(id) || id <= 0) {
    return jsonResponse(400, { error: "Valid observation id is required" });
  }

  const result = await handleGetObservation(deps, { id });
  return jsonResponse(result.status, result.body);
};

const handleGraphNeighborsRoute = async (
  deps: WorkerDeps,
  request: Request,
): Promise<Response> => {
  const params = getSearchParams(request);
  const id = parseInt(params.get("id") || "0", 10);
  if (!id || id <= 0) {
    return jsonResponse(400, { error: "Valid id required" });
  }
  const depth = parseInt(params.get("depth") || "1", 10);
  const result = await handleGetNeighbors(deps, { id, depth });
  return jsonResponse(result.status, result.body);
};

const handleGraphStatsRoute = async (
  deps: WorkerDeps,
  _request: Request,
): Promise<Response> => {
  const result = await handleGraphStats(deps);
  return jsonResponse(result.status, result.body);
};

const handleGraphBackfillRoute = async (
  deps: WorkerDeps,
  _request: Request,
): Promise<Response> => {
  const result = await handleGraphBackfill(deps);
  return jsonResponse(result.status, result.body);
};

// ============================================================================
// Router
// ============================================================================

const routes: readonly Route[] = [
  { method: "GET", path: "/health", handler: handleHealthRoute },
  { method: "POST", path: "/observation", handler: handleObservationRoute },
  { method: "POST", path: "/summary", handler: handleSummaryRoute },
  { method: "POST", path: "/retrieve", handler: handleRetrieveRoute },
  { method: "POST", path: "/complete", handler: handleCompleteRoute },
  { method: "GET", path: "/context", handler: handleContextRoute },
  { method: "GET", path: "/search", handler: handleSearchRoute },
  { method: "GET", path: "/timeline", handler: handleTimelineRoute },
  { method: "GET", path: "/decisions", handler: handleDecisionsRoute },
  { method: "GET", path: "/find_by_file", handler: handleFindByFileRoute },
  {
    method: "GET",
    path: "/observation_by_id",
    handler: handleObservationByIdRoute,
  },
  { method: "POST", path: "/backfill", handler: handleBackfillRoute },
  {
    method: "GET",
    path: "/backfill/status",
    handler: handleBackfillStatusRoute,
  },
  {
    method: "GET",
    path: "/graph/neighbors",
    handler: handleGraphNeighborsRoute,
  },
  { method: "GET", path: "/graph/stats", handler: handleGraphStatsRoute },
  {
    method: "POST",
    path: "/graph/backfill",
    handler: handleGraphBackfillRoute,
  },
];

export interface WorkerRouterOptions {
  readonly deps: WorkerDeps;
  readonly onShutdown?: () => void;
}

/**
 * Creates a worker router with the given dependencies.
 */
export const createWorkerRouter = (
  depsOrOptions: WorkerDeps | WorkerRouterOptions,
): WorkerRouter => {
  // Support both old signature (just deps) and new (options object)
  const isOptions = "deps" in depsOrOptions;
  const deps = isOptions ? depsOrOptions.deps : depsOrOptions;
  const onShutdown = isOptions ? depsOrOptions.onShutdown : undefined;

  const handle = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // Handle shutdown separately (needs callback, not just deps)
    if (path === "/shutdown" && method === "POST") {
      if (!onShutdown) {
        return jsonResponse(501, { error: "Shutdown not configured" });
      }
      const result = await handleShutdown(deps, onShutdown);
      return jsonResponse(result.status, result.body);
    }

    // Find matching route
    const route = routes.find((r) => r.path === path);

    if (!route) {
      return jsonResponse(404, { error: "Not found" });
    }

    if (route.method !== method) {
      return jsonResponse(405, {
        error: `Method ${method} not allowed for ${path}`,
      });
    }

    return route.handler(deps, request);
  };

  return { handle };
};
