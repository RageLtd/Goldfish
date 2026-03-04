/**
 * In-memory graph manager using Graphology.
 * SQLite is source of truth; this is the algorithm engine for fast traversal.
 * Factory function returns a plain object (no classes, per project pattern).
 */

import type { Database } from "bun:sqlite";
import Graph from "graphology";
import louvain from "graphology-communities-louvain";
import { degreeCentrality } from "graphology-metrics/centrality/degree";
import { bfsFromNode } from "graphology-traversal";
import { getAllEdges } from "../db/index";
import type { KnowledgeGraphEdge } from "../types/domain";
import { err, ok, type Result } from "../types/result";

// ============================================================================
// Types
// ============================================================================

export interface NodeMetadata {
  readonly centrality: number;
  readonly community: number;
  readonly degree: number;
}

export type NodeMetadataMap = ReadonlyMap<number, NodeMetadata>;

export interface NeighborInfo {
  readonly nodeId: number;
  readonly relation: string;
  readonly weight: number;
  readonly direction: string;
}

export interface GraphManager {
  readonly graph: Graph;
  hydrate(db: Database): Result<number>;
  addEdge(edge: KnowledgeGraphEdge): void;
  removeNode(observationId: number): void;
  getNeighborhood(id: number, depth: number): readonly number[];
  formatNeighborhood(id: number): readonly NeighborInfo[];
  recomputeMetadata(): NodeMetadataMap;
}

// ============================================================================
// Factory
// ============================================================================

export const createGraphManager = (): GraphManager => {
  const graph = new Graph({ multi: true, type: "mixed" });

  const ensureNode = (id: number): void => {
    const key = String(id);
    if (!graph.hasNode(key)) {
      graph.addNode(key, { id });
    }
  };

  const addEdge = (edge: KnowledgeGraphEdge): void => {
    ensureNode(edge.sourceId);
    ensureNode(edge.targetId);

    const edgeKey = `${edge.sourceId}-${edge.targetId}-${edge.relation}`;
    if (graph.hasEdge(edgeKey)) return;

    const attrs = {
      relation: edge.relation,
      weight: edge.weight,
      direction: edge.direction,
    };

    if (edge.direction === "bidirectional") {
      graph.addUndirectedEdgeWithKey(
        edgeKey,
        String(edge.sourceId),
        String(edge.targetId),
        attrs,
      );
    } else {
      graph.addDirectedEdgeWithKey(
        edgeKey,
        String(edge.sourceId),
        String(edge.targetId),
        attrs,
      );
    }
  };

  const hydrate = (db: Database): Result<number> => {
    const edgesResult = getAllEdges(db, {});
    if (!edgesResult.ok) {
      return err(edgesResult.error);
    }

    const edges = edgesResult.value;
    for (const edge of edges) {
      addEdge(edge);
    }

    return ok(edges.length);
  };

  const removeNode = (observationId: number): void => {
    const key = String(observationId);
    if (graph.hasNode(key)) {
      graph.dropNode(key);
    }
  };

  const getNeighborhood = (id: number, depth: number): readonly number[] => {
    const key = String(id);
    if (!graph.hasNode(key)) return [];

    const neighbors: number[] = [];
    bfsFromNode(graph, key, (_nodeKey, _attrs, currentDepth) => {
      if (currentDepth > depth) return true; // stop
      if (currentDepth > 0) {
        neighbors.push(Number(_nodeKey));
      }
    });

    return neighbors;
  };

  const formatNeighborhood = (id: number): readonly NeighborInfo[] => {
    const key = String(id);
    if (!graph.hasNode(key)) return [];

    const neighbors: NeighborInfo[] = [];
    graph.forEachEdge(key, (_edge, attrs, source, target) => {
      const neighborKey = source === key ? target : source;
      neighbors.push({
        nodeId: Number(neighborKey),
        relation: attrs.relation ?? "unknown",
        weight: attrs.weight ?? 1.0,
        direction: attrs.direction ?? "bidirectional",
      });
    });

    return neighbors;
  };

  const recomputeMetadata = (): NodeMetadataMap => {
    const metadata = new Map<number, NodeMetadata>();

    if (graph.order === 0) return metadata;

    // Degree centrality
    const centralities = degreeCentrality(graph);

    // Community detection (requires at least one edge)
    let communities: Record<string, number> = {};
    if (graph.size > 0) {
      try {
        communities = louvain(graph, { resolution: 1 });
      } catch {
        // Louvain can fail on disconnected graphs or edge cases
        for (const node of graph.nodes()) {
          communities[node] = 0;
        }
      }
    } else {
      for (const node of graph.nodes()) {
        communities[node] = 0;
      }
    }

    for (const node of graph.nodes()) {
      const id = Number(node);
      metadata.set(id, {
        centrality: centralities[node] ?? 0,
        community: communities[node] ?? 0,
        degree: graph.degree(node),
      });
    }

    return metadata;
  };

  return {
    graph,
    hydrate,
    addEdge,
    removeNode,
    getNeighborhood,
    formatNeighborhood,
    recomputeMetadata,
  };
};
