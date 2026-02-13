/**
 * ChromaDB sync - vector database for semantic search.
 * Syncs observations and summaries to ChromaDB for similarity queries.
 */

import { fromPromise, ok, type Result } from "../types/result";

// ============================================================================
// Types
// ============================================================================

export type EmbeddingFunction = (
  texts: readonly string[],
) => Promise<number[][]>;

export interface ChromaCollection {
  readonly add: (args: {
    ids: readonly string[];
    embeddings: readonly number[][];
    documents: readonly string[];
    metadatas: readonly Record<string, unknown>[];
  }) => Promise<void>;
  readonly query: (args: {
    queryEmbeddings: readonly number[][];
    nResults: number;
    where?: Record<string, unknown>;
  }) => Promise<{
    ids: readonly (readonly string[])[];
    documents: readonly (readonly string[])[];
    metadatas: readonly (readonly Record<string, unknown>[])[];
    distances: readonly (readonly number[])[];
  }>;
  readonly delete: (args: { where: Record<string, unknown> }) => Promise<void>;
  readonly count: () => Promise<number>;
}

export interface ChromaClient {
  readonly getOrCreateCollection: (args: {
    name: string;
  }) => Promise<ChromaCollection>;
}

export interface ChromaSyncDeps {
  readonly chromaClient: ChromaClient;
  readonly embeddingFn: EmbeddingFunction;
  readonly collectionName: string;
}

export interface AddObservationInput {
  readonly id: number;
  readonly sessionId: string;
  readonly type: string;
  readonly title: string | null;
  readonly narrative: string | null;
  readonly concepts: readonly string[];
  readonly project?: string;
}

export interface AddSummaryInput {
  readonly id: number;
  readonly sessionId: string;
  readonly request: string | null;
  readonly completed: string | null;
  readonly learned: string | null;
  readonly project?: string;
}

export interface SemanticSearchInput {
  readonly query: string;
  readonly limit: number;
  readonly project?: string;
}

export interface SearchResult {
  readonly id: string;
  readonly document: string;
  readonly metadata: Record<string, unknown>;
  readonly distance: number;
}

export interface ChromaSync {
  readonly addObservation: (
    input: AddObservationInput,
  ) => Promise<Result<void>>;
  readonly addSummary: (input: AddSummaryInput) => Promise<Result<void>>;
  readonly semanticSearch: (
    input: SemanticSearchInput,
  ) => Promise<Result<readonly SearchResult[]>>;
  readonly deleteBySessionId: (sessionId: string) => Promise<Result<void>>;
}

// ============================================================================
// Factory
// ============================================================================

export const createChromaSync = (deps: ChromaSyncDeps): ChromaSync => {
  const { chromaClient, embeddingFn, collectionName } = deps;

  const getCollection = async (): Promise<ChromaCollection> => {
    return chromaClient.getOrCreateCollection({ name: collectionName });
  };

  const addObservation = async (
    input: AddObservationInput,
  ): Promise<Result<void>> => {
    // Build document text for embedding
    const text = [
      input.title || "",
      input.narrative || "",
      input.concepts.join(" "),
    ]
      .filter(Boolean)
      .join(" ");

    if (!text.trim()) {
      return ok(undefined); // Nothing to embed
    }

    return fromPromise(
      (async () => {
        const collection = await getCollection();
        const embeddings = await embeddingFn([text]);
        await collection.add({
          ids: [`obs-${input.id}`],
          embeddings,
          documents: [text],
          metadatas: [
            {
              type: input.type,
              sessionId: input.sessionId,
              project: input.project || "",
              kind: "observation",
            },
          ],
        });
      })(),
    );
  };

  const addSummary = async (input: AddSummaryInput): Promise<Result<void>> => {
    // Build document text for embedding
    const text = [
      input.request || "",
      input.completed || "",
      input.learned || "",
    ]
      .filter(Boolean)
      .join(" ");

    if (!text.trim()) {
      return ok(undefined);
    }

    return fromPromise(
      (async () => {
        const collection = await getCollection();
        const embeddings = await embeddingFn([text]);
        await collection.add({
          ids: [`sum-${input.id}`],
          embeddings,
          documents: [text],
          metadatas: [
            {
              sessionId: input.sessionId,
              project: input.project || "",
              kind: "summary",
            },
          ],
        });
      })(),
    );
  };

  const semanticSearch = async (
    input: SemanticSearchInput,
  ): Promise<Result<readonly SearchResult[]>> => {
    const result = await fromPromise(
      (async () => {
        const collection = await getCollection();
        const queryEmbeddings = await embeddingFn([input.query]);

        // Build where clause
        const where: Record<string, unknown> = {};
        if (input.project) {
          where.project = input.project;
        }

        // Query collection
        const results = await collection.query({
          queryEmbeddings,
          nResults: input.limit,
          where: Object.keys(where).length > 0 ? where : undefined,
        });

        // Map to SearchResult
        const searchResults: SearchResult[] = [];
        const ids = results.ids[0] || [];
        const documents = results.documents[0] || [];
        const metadatas = results.metadatas[0] || [];
        const distances = results.distances[0] || [];

        for (let i = 0; i < ids.length; i++) {
          searchResults.push({
            id: ids[i],
            document: documents[i],
            metadata: metadatas[i],
            distance: distances[i],
          });
        }

        return searchResults as readonly SearchResult[];
      })(),
    );

    return result;
  };

  const deleteBySessionId = async (
    sessionId: string,
  ): Promise<Result<void>> => {
    return fromPromise(
      (async () => {
        const collection = await getCollection();
        await collection.delete({ where: { sessionId } });
      })(),
    );
  };

  return {
    addObservation,
    addSummary,
    semanticSearch,
    deleteBySessionId,
  };
};
