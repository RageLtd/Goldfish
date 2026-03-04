import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  createDatabase,
  createSession,
  deleteObservationsByIds,
  findSimilarObservation,
  getObservationById,
  getObservationsForPruning,
  getObservationsWithEmbeddings,
  getRecentObservations,
  runMigrations,
  storeObservation,
  storeSummary,
  updateObservationEmbedding,
} from "../../src/db/index";
import type { ParsedObservation, ParsedSummary } from "../../src/types/domain";

describe("database observations", () => {
  let db: Database;

  beforeEach(() => {
    // Use in-memory database for tests
    db = createDatabase(":memory:");
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  describe("storeObservation", () => {
    it("stores observation and returns id", () => {
      const createResult = createSession(db, {
        claudeSessionId: "claude-123",
        project: "test-project",
        userPrompt: "Test",
      });

      if (!createResult.ok) throw new Error("Setup failed");

      const observation: ParsedObservation = {
        type: "feature",
        title: "Added authentication",
        subtitle: "JWT-based auth flow",
        narrative: "Full implementation details",
        facts: ["Uses JWT", "Supports refresh"],
        concepts: ["how-it-works"],
        filesRead: ["auth.ts"],
        filesModified: ["user.ts"],
      };

      const result = storeObservation(db, {
        claudeSessionId: "claude-123",
        project: "test-project",
        observation,
        promptNumber: 1,
        discoveryTokens: 100,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBeGreaterThan(0);
      }
    });
  });

  describe("getObservationById", () => {
    it("returns observation when found", () => {
      createSession(db, {
        claudeSessionId: "claude-123",
        project: "test-project",
        userPrompt: "Test",
      });

      const observation: ParsedObservation = {
        type: "bugfix",
        title: "Fixed null check",
        subtitle: null,
        narrative: null,
        facts: [],
        concepts: [],
        filesRead: [],
        filesModified: ["fix.ts"],
      };

      const storeResult = storeObservation(db, {
        claudeSessionId: "claude-123",
        project: "test-project",
        observation,
        promptNumber: 1,
      });

      if (!storeResult.ok) throw new Error("Setup failed");

      const result = getObservationById(db, storeResult.value);

      expect(result.ok).toBe(true);
      if (result.ok && result.value) {
        expect(result.value.type).toBe("bugfix");
        expect(result.value.title).toBe("Fixed null check");
        expect(result.value.filesModified).toEqual(["fix.ts"]);
      }
    });
  });

  describe("getRecentObservations", () => {
    it("returns observations for project in descending order", () => {
      createSession(db, {
        claudeSessionId: "claude-123",
        project: "test-project",
        userPrompt: "Test",
      });

      const obs1: ParsedObservation = {
        type: "feature",
        title: "First",
        subtitle: null,
        narrative: null,
        facts: [],
        concepts: [],
        filesRead: [],
        filesModified: [],
      };

      const obs2: ParsedObservation = {
        type: "bugfix",
        title: "Second",
        subtitle: null,
        narrative: null,
        facts: [],
        concepts: [],
        filesRead: [],
        filesModified: [],
      };

      storeObservation(db, {
        claudeSessionId: "claude-123",
        project: "test-project",
        observation: obs1,
        promptNumber: 1,
      });

      storeObservation(db, {
        claudeSessionId: "claude-123",
        project: "test-project",
        observation: obs2,
        promptNumber: 1,
      });

      const result = getRecentObservations(db, {
        project: "test-project",
        limit: 10,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveLength(2);
        // Most recent first
        expect(result.value[0].title).toBe("Second");
        expect(result.value[1].title).toBe("First");
      }
    });
  });

  describe("storeSummary", () => {
    it("stores summary and returns id", () => {
      createSession(db, {
        claudeSessionId: "claude-123",
        project: "test-project",
        userPrompt: "Test",
      });

      const summary: ParsedSummary = {
        request: "Implement auth",
        investigated: "Existing patterns",
        learned: "Uses JWT",
        completed: "Basic auth flow",
        nextSteps: "Add OAuth",
        notes: null,
      };

      const result = storeSummary(db, {
        claudeSessionId: "claude-123",
        project: "test-project",
        summary,
        promptNumber: 1,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBeGreaterThan(0);
      }
    });
  });

  describe("embedding column", () => {
    it("stores and retrieves embedding blob on observations", () => {
      // Create session first
      createSession(db, {
        claudeSessionId: "embed-test",
        project: "test",
        userPrompt: "test",
      });

      // Store observation
      const obsResult = storeObservation(db, {
        claudeSessionId: "embed-test",
        project: "test",
        observation: {
          type: "discovery",
          title: "Test embedding",
          subtitle: null,
          narrative: "test",
          facts: [],
          concepts: [],
          filesRead: [],
          filesModified: [],
        },
        promptNumber: 1,
      });
      expect(obsResult.ok).toBe(true);

      // Verify we can store an embedding for this observation
      const embedding = new Float32Array([0.1, 0.2, 0.3]);
      const buffer = Buffer.from(embedding.buffer);
      db.run("UPDATE observations SET embedding = ? WHERE id = ?", [
        buffer,
        obsResult.ok ? obsResult.value : -1,
      ]);

      // Retrieve and verify
      const row = db
        .query<{ embedding: Buffer | null }, [number]>(
          "SELECT embedding FROM observations WHERE id = ?",
        )
        .get(obsResult.ok ? obsResult.value : -1);

      expect(row).not.toBeNull();
      expect(row!.embedding).not.toBeNull();
      const retrieved = new Float32Array(
        row!.embedding!.buffer,
        row!.embedding!.byteOffset,
        row!.embedding!.byteLength / 4,
      );
      expect(retrieved[0]).toBeCloseTo(0.1);
      expect(retrieved[1]).toBeCloseTo(0.2);
      expect(retrieved[2]).toBeCloseTo(0.3);
    });
  });

  describe("findSimilarObservation", () => {
    it("returns null when no similar observations exist", () => {
      const result = findSimilarObservation(db, {
        project: "test-project",
        title: "Completely unique title",
        withinMs: 3600000,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBeNull();
      }
    });

    it("finds similar observation within time window", () => {
      createSession(db, {
        claudeSessionId: "sess-1",
        project: "test-project",
        userPrompt: "Test",
      });

      storeObservation(db, {
        claudeSessionId: "sess-1",
        project: "test-project",
        observation: {
          type: "discovery",
          title: "Database connection pooling exhausts connections",
          subtitle: null,
          narrative: "Found connection leak",
          facts: [],
          concepts: [],
          filesRead: [],
          filesModified: [],
        },
        promptNumber: 1,
      });

      const result = findSimilarObservation(db, {
        project: "test-project",
        title: "Database connection pooling exhausts connections slowly",
        withinMs: 3600000,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).not.toBeNull();
      }
    });

    it("ignores observations from different projects", () => {
      const result = findSimilarObservation(db, {
        project: "different-project",
        title: "Database connection pooling exhausts connections",
        withinMs: 3600000,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBeNull();
      }
    });
  });

  describe("deleteObservationsByIds", () => {
    it("deletes observations by ID list", () => {
      createSession(db, {
        claudeSessionId: "sess-del",
        project: "test",
        userPrompt: "Test",
      });

      const id1 = storeObservation(db, {
        claudeSessionId: "sess-del",
        project: "test",
        observation: {
          type: "discovery",
          title: "First obs",
          subtitle: null,
          narrative: "first",
          facts: [],
          concepts: [],
          filesRead: [],
          filesModified: [],
        },
        promptNumber: 1,
      });

      const id2 = storeObservation(db, {
        claudeSessionId: "sess-del",
        project: "test",
        observation: {
          type: "discovery",
          title: "Second obs",
          subtitle: null,
          narrative: "second",
          facts: [],
          concepts: [],
          filesRead: [],
          filesModified: [],
        },
        promptNumber: 2,
      });

      expect(id1.ok && id2.ok).toBe(true);
      if (!id1.ok || !id2.ok) return;

      const result = deleteObservationsByIds(db, { ids: [id1.value] });
      expect(result.ok).toBe(true);
      if (result.ok) {
        // changes count includes FTS trigger operations, so just check > 0
        expect(result.value).toBeGreaterThan(0);
      }

      // Verify only one remains
      const remaining = getRecentObservations(db, { limit: 10 });
      expect(remaining.ok).toBe(true);
      if (remaining.ok) {
        expect(remaining.value).toHaveLength(1);
        expect(remaining.value[0].title).toBe("Second obs");
      }
    });

    it("returns 0 for empty ID list", () => {
      const result = deleteObservationsByIds(db, { ids: [] });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(0);
      }
    });
  });

  describe("getObservationsForPruning", () => {
    it("returns observations with pruning metadata", () => {
      createSession(db, {
        claudeSessionId: "sess-prune",
        project: "test",
        userPrompt: "Test",
      });

      storeObservation(db, {
        claudeSessionId: "sess-prune",
        project: "test",
        observation: {
          type: "bugfix",
          title: "Fix something",
          subtitle: null,
          narrative: "Fixed it",
          facts: [],
          concepts: [],
          filesRead: [],
          filesModified: [],
        },
        promptNumber: 1,
      });

      const result = getObservationsForPruning(db);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBeGreaterThan(0);
        const candidate = result.value[0];
        expect(candidate.id).toBeGreaterThan(0);
        expect(candidate.type).toBe("bugfix");
        expect(candidate.project).toBe("test");
        expect(candidate.hasEmbedding).toBe(false);
      }
    });
  });

  describe("getObservationsWithEmbeddings", () => {
    it("returns observations that have embeddings", () => {
      createSession(db, {
        claudeSessionId: "sess-emb",
        project: "test",
        userPrompt: "Test",
      });

      const obsResult = storeObservation(db, {
        claudeSessionId: "sess-emb",
        project: "test",
        observation: {
          type: "discovery",
          title: "Embedded obs",
          subtitle: null,
          narrative: "Has embedding",
          facts: [],
          concepts: [],
          filesRead: [],
          filesModified: [],
        },
        promptNumber: 1,
      });
      expect(obsResult.ok).toBe(true);
      if (!obsResult.ok) return;

      // Store embedding
      const embedding = new Float32Array([0.1, 0.2, 0.3]);
      updateObservationEmbedding(db, obsResult.value, embedding);

      // Also store one without embedding
      storeObservation(db, {
        claudeSessionId: "sess-emb",
        project: "test",
        observation: {
          type: "discovery",
          title: "No embedding obs",
          subtitle: null,
          narrative: "No embedding",
          facts: [],
          concepts: [],
          filesRead: [],
          filesModified: [],
        },
        promptNumber: 2,
      });

      const result = getObservationsWithEmbeddings(db, { limit: 10 });
      expect(result.ok).toBe(true);
      if (result.ok) {
        // Only the one with embedding should be returned
        expect(result.value).toHaveLength(1);
        expect(result.value[0].title).toBe("Embedded obs");
        expect(result.value[0].embedding.length).toBe(3);
      }
    });

    it("returns empty for no embeddings", () => {
      const result = getObservationsWithEmbeddings(db, { limit: 10 });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveLength(0);
      }
    });
  });
});
