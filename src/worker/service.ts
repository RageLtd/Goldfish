/**
 * Worker HTTP service router.
 * Pure functional router that maps requests to handlers.
 */

import {
	type CompleteSessionInput,
	handleCompleteSession,
	handleGetContext,
	handleHealth,
	handleQueueObservation,
	handleQueuePrompt,
	handleQueueSummary,
	handleSearch,
	type QueueObservationInput,
	type QueuePromptInput,
	type QueueSummaryInput,
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

const parseJsonBody = async <T>(request: Request): Promise<T | null> => {
	try {
		return (await request.json()) as T;
	} catch {
		return null;
	}
};

const getSearchParams = (request: Request): URLSearchParams => {
	const url = new URL(request.url);
	return url.searchParams;
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
	});

	return jsonResponse(result.status, result.body);
};

const handlePromptRoute = async (
	deps: WorkerDeps,
	request: Request,
): Promise<Response> => {
	const body = await parseJsonBody<QueuePromptInput>(request);
	if (!body) {
		return jsonResponse(400, { error: "Invalid JSON body" });
	}

	const result = await handleQueuePrompt(deps, {
		claudeSessionId: body.claudeSessionId || "",
		prompt: body.prompt || "",
		cwd: body.cwd || "",
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
	const project = params.get("project");
	const limit = parseInt(params.get("limit") || "10", 10);

	if (!project) {
		return jsonResponse(400, { error: "project parameter is required" });
	}

	const result = await handleGetContext(deps, { project, limit });
	return jsonResponse(result.status, result.body);
};

const handleSearchRoute = async (
	deps: WorkerDeps,
	request: Request,
): Promise<Response> => {
	const params = getSearchParams(request);
	const query = params.get("query");
	const type = params.get("type") as "observations" | "summaries";
	const project = params.get("project") || undefined;
	const limit = parseInt(params.get("limit") || "10", 10);

	if (!query) {
		return jsonResponse(400, { error: "query parameter is required" });
	}

	if (!type || (type !== "observations" && type !== "summaries")) {
		return jsonResponse(400, {
			error: "type parameter must be 'observations' or 'summaries'",
		});
	}

	const result = await handleSearch(deps, { query, type, project, limit });
	return jsonResponse(result.status, result.body);
};

// ============================================================================
// Router
// ============================================================================

const routes: readonly Route[] = [
	{ method: "GET", path: "/health", handler: handleHealthRoute },
	{ method: "POST", path: "/observation", handler: handleObservationRoute },
	{ method: "POST", path: "/summary", handler: handleSummaryRoute },
	{ method: "POST", path: "/prompt", handler: handlePromptRoute },
	{ method: "POST", path: "/complete", handler: handleCompleteRoute },
	{ method: "GET", path: "/context", handler: handleContextRoute },
	{ method: "GET", path: "/search", handler: handleSearchRoute },
];

/**
 * Creates a worker router with the given dependencies.
 */
export const createWorkerRouter = (deps: WorkerDeps): WorkerRouter => {
	const handle = async (request: Request): Promise<Response> => {
		const url = new URL(request.url);
		const path = url.pathname;
		const method = request.method;

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
