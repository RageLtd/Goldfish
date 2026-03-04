/**
 * Graph handlers: neighbors, stats, backfill.
 */

import { runGraphBackfill } from "../../commands/graph";
import { getObservationById } from "../../db/index";
import type { GraphNeighborsInput, HandlerResponse, WorkerDeps } from "./types";

/**
 * Returns neighbors of an observation in the knowledge graph.
 */
export const handleGetNeighbors = async (
  deps: WorkerDeps,
  input: GraphNeighborsInput,
): Promise<HandlerResponse> => {
  if (!deps.graphManager) {
    return {
      status: 503,
      body: { error: "Graph not available" },
    };
  }

  const neighbors = deps.graphManager.formatNeighborhood(input.id);

  const enriched = neighbors.map((n) => {
    const obsResult = getObservationById(deps.db, n.nodeId);
    const title =
      obsResult.ok && obsResult.value ? obsResult.value.title : null;
    return {
      nodeId: n.nodeId,
      title,
      relation: n.relation,
      weight: n.weight,
      direction: n.direction,
    };
  });

  return {
    status: 200,
    body: {
      observationId: input.id,
      neighbors: enriched,
    },
  };
};

/**
 * Returns graph statistics: node/edge counts, communities, top central nodes.
 */
export const handleGraphStats = async (
  deps: WorkerDeps,
): Promise<HandlerResponse> => {
  if (!deps.graphManager) {
    return {
      status: 503,
      body: { error: "Graph not available" },
    };
  }

  const { graph } = deps.graphManager;
  const metadata = deps.graphManager.recomputeMetadata();

  const communitySet = new Set<number>();
  const entries: {
    id: number;
    centrality: number;
    degree: number;
  }[] = [];

  for (const [id, meta] of metadata) {
    communitySet.add(meta.community);
    entries.push({ id, centrality: meta.centrality, degree: meta.degree });
  }

  entries.sort((a, b) => b.centrality - a.centrality);
  const top10 = entries.slice(0, 10);

  const topCentral = top10.map((e) => {
    const obsResult = getObservationById(deps.db, e.id);
    const title =
      obsResult.ok && obsResult.value ? obsResult.value.title : null;
    return {
      id: e.id,
      title,
      centrality: e.centrality,
      degree: e.degree,
    };
  });

  return {
    status: 200,
    body: {
      nodes: graph.order,
      edges: graph.size,
      communities: communitySet.size,
      topCentral,
    },
  };
};

/**
 * Triggers graph backfill (no LLM, not dry run).
 */
export const handleGraphBackfill = async (
  deps: WorkerDeps,
): Promise<HandlerResponse> => {
  if (!deps.graphManager) {
    return {
      status: 503,
      body: { error: "Graph not available" },
    };
  }

  const result = await runGraphBackfill(deps.db, deps.graphManager, {
    dryRun: false,
  });

  return {
    status: 200,
    body: {
      candidates: result.candidates,
      processed: result.processed,
      edgesCreated: result.edgesCreated,
    },
  };
};
