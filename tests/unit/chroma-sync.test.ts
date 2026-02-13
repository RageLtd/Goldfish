/**
 * Tests for ChromaDB sync - vector database for semantic search.
 * Tests are written first following TDD principles.
 */

import { describe, expect, it, mock } from "bun:test";
import {
  type ChromaSyncDeps,
  createChromaSync,
  type EmbeddingFunction,
} from "../../src/services/chroma-sync";

// ============================================================================
// Test Helpers
// ============================================================================

const createMockEmbeddingFn = (): EmbeddingFunction => {
  return mock(async (texts: readonly string[]) => {
    // Return mock embeddings (1536 dimensions like OpenAI)
    return texts.map(() => Array(1536).fill(0.1));
  });
};

const createMockChromaClient = () => ({
  getOrCreateCollection: mock(async () => ({
    add: mock(async () => {}),
    query: mock(async () => ({
      ids: [["obs-1", "obs-2"]],
      documents: [["doc1", "doc2"]],
      metadatas: [[{ type: "feature" }, { type: "bugfix" }]],
      distances: [[0.1, 0.2]],
    })),
    delete: mock(async () => {}),
    count: mock(async () => 10),
  })),
});

// ============================================================================
// Tests
// ============================================================================

describe("ChromaSync", () => {
  describe("createChromaSync", () => {
    it("creates a sync service with required methods", () => {
      const deps: ChromaSyncDeps = {
        chromaClient: createMockChromaClient(),
        embeddingFn: createMockEmbeddingFn(),
        collectionName: "test-observations",
      };

      const sync = createChromaSync(deps);

      expect(sync.addObservation).toBeDefined();
      expect(sync.addSummary).toBeDefined();
      expect(sync.semanticSearch).toBeDefined();
      expect(sync.deleteBySessionId).toBeDefined();
    });
  });

  describe("addObservation", () => {
    it("adds observation to collection", async () => {
      const mockCollection = {
        add: mock(async () => {}),
        query: mock(async () => ({
          ids: [[]],
          documents: [[]],
          metadatas: [[]],
          distances: [[]],
        })),
        delete: mock(async () => {}),
        count: mock(async () => 0),
      };

      const mockClient = {
        getOrCreateCollection: mock(async () => mockCollection),
      };

      const deps: ChromaSyncDeps = {
        chromaClient: mockClient,
        embeddingFn: createMockEmbeddingFn(),
        collectionName: "test-observations",
      };

      const sync = createChromaSync(deps);
      const result = await sync.addObservation({
        id: 1,
        sessionId: "session-1",
        type: "feature",
        title: "Test feature",
        narrative: "This is a test narrative",
        concepts: ["how-it-works"],
      });

      expect(result.ok).toBe(true);
      expect(mockCollection.add).toHaveBeenCalled();
    });

    it("handles embedding errors gracefully", async () => {
      const mockClient = createMockChromaClient();
      const failingEmbeddingFn = mock(async () => {
        throw new Error("Embedding failed");
      });

      const deps: ChromaSyncDeps = {
        chromaClient: mockClient,
        embeddingFn: failingEmbeddingFn,
        collectionName: "test-observations",
      };

      const sync = createChromaSync(deps);
      const result = await sync.addObservation({
        id: 1,
        sessionId: "session-1",
        type: "feature",
        title: "Test",
        narrative: "Test",
        concepts: [],
      });

      expect(result.ok).toBe(false);
      expect(result.error?.message).toContain("Embedding failed");
    });
  });

  describe("addSummary", () => {
    it("adds summary to collection", async () => {
      const mockCollection = {
        add: mock(async () => {}),
        query: mock(async () => ({
          ids: [[]],
          documents: [[]],
          metadatas: [[]],
          distances: [[]],
        })),
        delete: mock(async () => {}),
        count: mock(async () => 0),
      };

      const mockClient = {
        getOrCreateCollection: mock(async () => mockCollection),
      };

      const deps: ChromaSyncDeps = {
        chromaClient: mockClient,
        embeddingFn: createMockEmbeddingFn(),
        collectionName: "test-summaries",
      };

      const sync = createChromaSync(deps);
      const result = await sync.addSummary({
        id: 1,
        sessionId: "session-1",
        request: "Implement auth",
        completed: "Auth implemented",
        learned: "OAuth is complex",
      });

      expect(result.ok).toBe(true);
      expect(mockCollection.add).toHaveBeenCalled();
    });
  });

  describe("semanticSearch", () => {
    it("returns similar items", async () => {
      const mockCollection = {
        add: mock(async () => {}),
        query: mock(async () => ({
          ids: [["obs-1", "obs-2"]],
          documents: [["Authentication implementation", "Bug fix for login"]],
          metadatas: [
            [
              { type: "feature", sessionId: "s1" },
              { type: "bugfix", sessionId: "s2" },
            ],
          ],
          distances: [[0.1, 0.2]],
        })),
        delete: mock(async () => {}),
        count: mock(async () => 2),
      };

      const mockClient = {
        getOrCreateCollection: mock(async () => mockCollection),
      };

      const deps: ChromaSyncDeps = {
        chromaClient: mockClient,
        embeddingFn: createMockEmbeddingFn(),
        collectionName: "test-observations",
      };

      const sync = createChromaSync(deps);
      const result = await sync.semanticSearch({
        query: "How does authentication work?",
        limit: 5,
      });

      expect(result.ok).toBe(true);
      expect(result.value?.length).toBe(2);
      expect(result.value?.[0].document).toContain("Authentication");
    });

    it("filters by project", async () => {
      const mockCollection = {
        add: mock(async () => {}),
        query: mock(
          async (_args: {
            queryEmbeddings: number[][];
            nResults: number;
            where?: Record<string, unknown>;
          }) => ({
            ids: [["obs-1"]],
            documents: [["Project specific result"]],
            metadatas: [[{ type: "feature", project: "my-project" }]],
            distances: [[0.1]],
          }),
        ),
        delete: mock(async () => {}),
        count: mock(async () => 1),
      };

      const mockClient = {
        getOrCreateCollection: mock(async () => mockCollection),
      };

      const deps: ChromaSyncDeps = {
        chromaClient: mockClient,
        embeddingFn: createMockEmbeddingFn(),
        collectionName: "test-observations",
      };

      const sync = createChromaSync(deps);
      const result = await sync.semanticSearch({
        query: "test",
        project: "my-project",
        limit: 5,
      });

      expect(result.ok).toBe(true);
      expect(mockCollection.query).toHaveBeenCalled();
    });

    it("handles empty results", async () => {
      const mockCollection = {
        add: mock(async () => {}),
        query: mock(async () => ({
          ids: [[]],
          documents: [[]],
          metadatas: [[]],
          distances: [[]],
        })),
        delete: mock(async () => {}),
        count: mock(async () => 0),
      };

      const mockClient = {
        getOrCreateCollection: mock(async () => mockCollection),
      };

      const deps: ChromaSyncDeps = {
        chromaClient: mockClient,
        embeddingFn: createMockEmbeddingFn(),
        collectionName: "test-observations",
      };

      const sync = createChromaSync(deps);
      const result = await sync.semanticSearch({
        query: "nonexistent topic",
        limit: 5,
      });

      expect(result.ok).toBe(true);
      expect(result.value?.length).toBe(0);
    });
  });

  describe("deleteBySessionId", () => {
    it("deletes all items for a session", async () => {
      const mockCollection = {
        add: mock(async () => {}),
        query: mock(async () => ({
          ids: [[]],
          documents: [[]],
          metadatas: [[]],
          distances: [[]],
        })),
        delete: mock(async () => {}),
        count: mock(async () => 0),
      };

      const mockClient = {
        getOrCreateCollection: mock(async () => mockCollection),
      };

      const deps: ChromaSyncDeps = {
        chromaClient: mockClient,
        embeddingFn: createMockEmbeddingFn(),
        collectionName: "test-observations",
      };

      const sync = createChromaSync(deps);
      const result = await sync.deleteBySessionId("session-1");

      expect(result.ok).toBe(true);
      expect(mockCollection.delete).toHaveBeenCalled();
    });
  });
});
