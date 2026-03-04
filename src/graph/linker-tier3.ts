/**
 * Tier 3: LLM-based edge enrichment.
 * Multi-turn agent loop where the model can query the existing graph for
 * context, then classify semantic relationships between observations.
 */

import type { Database } from "bun:sqlite";
import { getObservationById } from "../db/index";
import type {
  ChatMessage,
  ModelManager,
  ToolDefinition,
} from "../models/manager";
import {
  buildGraphEnrichmentPrompt,
  CLASSIFY_RELATIONSHIP_TOOL,
  type GraphEnrichmentObservation,
  QUERY_GRAPH_TOOL,
} from "../models/prompts";
import { parseGraphToolCall } from "../models/tool-call-parser";
import type { ProposedEdge } from "./linker-shared";
import type { GraphManager } from "./manager";

// ============================================================================
// Types
// ============================================================================

export interface Tier3Candidate {
  readonly id: number;
  readonly similarity: number;
}

export interface Tier3Input {
  readonly observationId: number;
  readonly candidates: readonly Tier3Candidate[];
}

// ============================================================================
// Configuration
// ============================================================================

const SIMILARITY_THRESHOLD = 0.65;
const MAX_CANDIDATES = 10;
const MAX_TURNS = 4;
const MIN_STRENGTH = 0.5;

const VALID_RELATIONSHIPS = new Set([
  "caused-by",
  "supersedes",
  "implements",
  "relates-to",
]);

const DIRECTION_MAP: Record<string, "directed" | "bidirectional"> = {
  "a-to-b": "directed",
  "b-to-a": "directed",
  bidirectional: "bidirectional",
};

const GRAPH_TOOLS: readonly ToolDefinition[] = [
  QUERY_GRAPH_TOOL,
  CLASSIFY_RELATIONSHIP_TOOL,
];

// ============================================================================
// Helpers
// ============================================================================

const log = (msg: string) => console.log(`[linker-tier3] ${msg}`);

/**
 * Loads a compact observation summary from the database.
 */
const loadObsSummary = (
  db: Database,
  id: number,
): GraphEnrichmentObservation | null => {
  const result = getObservationById(db, id);
  if (!result.ok || !result.value) return null;
  const obs = result.value;
  return {
    id: obs.id,
    type: obs.type,
    title: obs.title ?? `Observation #${obs.id}`,
    narrative: obs.narrative ?? "",
  };
};

/**
 * Formats the graph neighborhood as a tool result string,
 * enriched with observation titles from the database.
 */
const formatNeighborhoodResult = (
  db: Database,
  graphManager: GraphManager,
  observationId: number,
): string => {
  const neighbors = graphManager.formatNeighborhood(observationId);
  if (neighbors.length === 0) {
    return `Observation #${observationId} has no graph connections.`;
  }

  const lines = neighbors.map((n) => {
    const obs = loadObsSummary(db, n.nodeId);
    const title = obs ? obs.title : `#${n.nodeId}`;
    return `- [${n.nodeId}] ${title} (${n.relation}, weight=${n.weight}, ${n.direction})`;
  });

  return `Neighbors of #${observationId}:\n${lines.join("\n")}`;
};

// ============================================================================
// Core
// ============================================================================

/**
 * Multi-turn agent loop for LLM-based relationship classification.
 * Filters candidates by similarity, builds prompts, and runs inference
 * with query_graph and classify_relationship tools.
 */
export const enrichWithLLM = async (
  db: Database,
  graphManager: GraphManager,
  modelManager: ModelManager,
  input: Tier3Input,
): Promise<readonly ProposedEdge[]> => {
  const { observationId, candidates } = input;

  // Filter and cap candidates
  const filtered = candidates
    .filter(
      (c) => c.similarity >= SIMILARITY_THRESHOLD && c.id !== observationId,
    )
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, MAX_CANDIDATES);

  if (filtered.length === 0) return [];

  // Load observation summaries
  const source = loadObsSummary(db, observationId);
  if (!source) return [];

  const candidateObs: GraphEnrichmentObservation[] = [];
  for (const c of filtered) {
    const obs = loadObsSummary(db, c.id);
    if (obs) candidateObs.push(obs);
  }

  if (candidateObs.length === 0) return [];

  // Build initial prompt
  const prompt = buildGraphEnrichmentPrompt(source, candidateObs);
  const messages: ChatMessage[] = [
    { role: "system", content: prompt.system },
    { role: "user", content: prompt.user },
  ];

  // Multi-turn agent loop
  let queryCount = 0;
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    let response: string;
    try {
      response = await modelManager.generateText(messages, GRAPH_TOOLS);
    } catch (e) {
      log(
        `Model error on turn ${turn}: ${e instanceof Error ? e.message : String(e)}`,
      );
      return [];
    }

    const toolCall = parseGraphToolCall(response);
    if (!toolCall) {
      // No tool call found — model didn't produce usable output
      return [];
    }

    if (toolCall.kind === "query_graph") {
      if (queryCount >= 2) {
        // Max query_graph calls reached, skip and continue
        messages.push({ role: "assistant", content: response });
        messages.push({
          role: "user",
          content:
            "Maximum graph queries reached. Please call classify_relationship now.",
        });
        continue;
      }

      queryCount++;
      const result = formatNeighborhoodResult(
        db,
        graphManager,
        toolCall.observationId,
      );
      messages.push({ role: "assistant", content: response });
      messages.push({ role: "user", content: result });
      continue;
    }

    if (toolCall.kind === "classify_relationship") {
      // Convert classifications to ProposedEdges
      const edges: ProposedEdge[] = [];
      const validIds = new Set([observationId, ...filtered.map((c) => c.id)]);

      for (const rel of toolCall.relationships) {
        // Filter by strength
        if (rel.strength < MIN_STRENGTH) continue;

        // Validate relationship type
        if (!VALID_RELATIONSHIPS.has(rel.relationship)) continue;

        // Validate IDs are in our candidate set
        if (!validIds.has(rel.sourceId) || !validIds.has(rel.targetId))
          continue;

        // Map direction
        const edgeDirection = DIRECTION_MAP[rel.direction];
        if (!edgeDirection) continue;

        // Handle b-to-a by swapping source and target
        const [src, tgt] =
          rel.direction === "b-to-a"
            ? [rel.targetId, rel.sourceId]
            : [rel.sourceId, rel.targetId];

        edges.push({
          sourceId: src,
          targetId: tgt,
          relation: rel.relationship as ProposedEdge["relation"],
          weight: rel.strength,
          direction: edgeDirection,
          explanation: rel.explanation ?? null,
        });
      }

      log(`LLM classified ${edges.length} edges for obs #${observationId}`);
      return edges;
    }
  }

  // Max turns exceeded without classify_relationship
  log(
    `Max turns reached for obs #${observationId}, no classification produced`,
  );
  return [];
};
