import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  createDatabase,
  createSession,
  findSimilarObservation,
  getCandidateObservations,
  getObservationById,
  getRecentObservations,
  getSessionByClaudeId,
  incrementPromptCounter,
  runMigrations,
  saveUserPrompt,
  searchObservations,
  storeObservation,
  storeSummary,
  updateSessionStatus,
} from "../../src/db/index";
import type { ParsedObservation, ParsedSummary } from "../../src/types/domain";

describe("database", () => {
  let db: Database;

  beforeEach(() => {
    // Use in-memory database for tests
    db = createDatabase(":memory:");
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  describe("createSession", () => {
    it("creates a new session and returns id with isNew=true", () => {
      const result = createSession(db, {
        claudeSessionId: "claude-123",
        project: "test-project",
        userPrompt: "Help me with something",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.id).toBeGreaterThan(0);
        expect(result.value.isNew).toBe(true);
      }
    });

    it("is idempotent - returns existing session with isNew=false on duplicate", () => {
      const first = createSession(db, {
        claudeSessionId: "claude-123",
        project: "test-project",
        userPrompt: "First prompt",
      });

      const second = createSession(db, {
        claudeSessionId: "claude-123",
        project: "test-project",
        userPrompt: "Second prompt",
      });

      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      if (first.ok && second.ok) {
        expect(first.value.id).toBe(second.value.id);
        expect(first.value.isNew).toBe(true);
        expect(second.value.isNew).toBe(false);
      }
    });
  });

  describe("getSessionByClaudeId", () => {
    it("returns session when found", () => {
      createSession(db, {
        claudeSessionId: "claude-123",
        project: "test-project",
        userPrompt: "Test prompt",
      });

      const result = getSessionByClaudeId(db, "claude-123");

      expect(result.ok).toBe(true);
      if (result.ok && result.value) {
        expect(result.value.claudeSessionId).toBe("claude-123");
        expect(result.value.project).toBe("test-project");
        expect(result.value.status).toBe("active");
      }
    });

    it("returns null when not found", () => {
      const result = getSessionByClaudeId(db, "nonexistent");

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBeNull();
      }
    });
  });

  describe("updateSessionStatus", () => {
    it("updates status to completed", () => {
      const createResult = createSession(db, {
        claudeSessionId: "claude-123",
        project: "test-project",
        userPrompt: "Test",
      });

      if (!createResult.ok) throw new Error("Setup failed");

      const updateResult = updateSessionStatus(
        db,
        createResult.value.id,
        "completed",
      );
      expect(updateResult.ok).toBe(true);

      const session = getSessionByClaudeId(db, "claude-123");
      if (session.ok && session.value) {
        expect(session.value.status).toBe("completed");
        expect(session.value.completedAt).not.toBeNull();
      }
    });
  });

  describe("incrementPromptCounter", () => {
    it("increments counter and returns new value", () => {
      const createResult = createSession(db, {
        claudeSessionId: "claude-123",
        project: "test-project",
        userPrompt: "Test",
      });

      if (!createResult.ok) throw new Error("Setup failed");

      const result1 = incrementPromptCounter(db, createResult.value.id);
      expect(result1.ok).toBe(true);
      if (result1.ok) expect(result1.value).toBe(2);

      const result2 = incrementPromptCounter(db, createResult.value.id);
      expect(result2.ok).toBe(true);
      if (result2.ok) expect(result2.value).toBe(3);
    });
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

  describe("saveUserPrompt", () => {
    it("stores user prompt", () => {
      createSession(db, {
        claudeSessionId: "claude-123",
        project: "test-project",
        userPrompt: "Initial",
      });

      const result = saveUserPrompt(db, {
        claudeSessionId: "claude-123",
        promptNumber: 1,
        promptText: "Help me fix a bug",
      });

      expect(result.ok).toBe(true);
    });
  });

  describe("searchObservations", () => {
    it("finds observations by text search", () => {
      createSession(db, {
        claudeSessionId: "claude-123",
        project: "test-project",
        userPrompt: "Test",
      });

      const obs: ParsedObservation = {
        type: "feature",
        title: "Authentication system",
        subtitle: "JWT tokens",
        narrative: "Implemented secure authentication",
        facts: ["Uses bcrypt for passwords"],
        concepts: ["security"],
        filesRead: [],
        filesModified: [],
      };

      storeObservation(db, {
        claudeSessionId: "claude-123",
        project: "test-project",
        observation: obs,
        promptNumber: 1,
      });

      const result = searchObservations(db, {
        query: "authentication",
        limit: 10,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBeGreaterThan(0);
        expect(result.value[0].title).toContain("Authentication");
      }
    });

    it("filters by project", () => {
      createSession(db, {
        claudeSessionId: "session-a",
        project: "project-a",
        userPrompt: "Test",
      });

      createSession(db, {
        claudeSessionId: "session-b",
        project: "project-b",
        userPrompt: "Test",
      });

      const obs: ParsedObservation = {
        type: "feature",
        title: "Test feature",
        subtitle: null,
        narrative: null,
        facts: [],
        concepts: [],
        filesRead: [],
        filesModified: [],
      };

      storeObservation(db, {
        claudeSessionId: "session-a",
        project: "project-a",
        observation: obs,
        promptNumber: 1,
      });

      storeObservation(db, {
        claudeSessionId: "session-b",
        project: "project-b",
        observation: { ...obs, title: "Other feature" },
        promptNumber: 1,
      });

      const result = searchObservations(db, {
        query: "feature",
        project: "project-a",
        limit: 10,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveLength(1);
        expect(result.value[0].project).toBe("project-a");
      }
    });

    it("filters by concept", () => {
      createSession(db, {
        claudeSessionId: "claude-123",
        project: "test-project",
        userPrompt: "Test",
      });

      const decisionObs: ParsedObservation = {
        type: "decision",
        title: "Use TypeScript",
        subtitle: null,
        narrative: "We decided to use TypeScript for type safety",
        facts: [],
        concepts: ["decision", "architecture"],
        filesRead: [],
        filesModified: [],
      };

      const featureObs: ParsedObservation = {
        type: "feature",
        title: "Add search feature",
        subtitle: null,
        narrative: "Implemented search functionality",
        facts: [],
        concepts: ["feature", "search"],
        filesRead: [],
        filesModified: [],
      };

      storeObservation(db, {
        claudeSessionId: "claude-123",
        project: "test-project",
        observation: decisionObs,
        promptNumber: 1,
      });

      storeObservation(db, {
        claudeSessionId: "claude-123",
        project: "test-project",
        observation: featureObs,
        promptNumber: 2,
      });

      // Test concept filtering - should only return decision
      const result = searchObservations(db, {
        query: "TypeScript OR search",
        concept: "decision",
        limit: 10,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveLength(1);
        expect(result.value[0].title).toBe("Use TypeScript");
        expect(result.value[0].concepts).toContain("decision");
      }
    });

    it("concept filter is case-insensitive", () => {
      createSession(db, {
        claudeSessionId: "claude-123",
        project: "test-project",
        userPrompt: "Test",
      });

      const obs: ParsedObservation = {
        type: "decision",
        title: "Test decision",
        subtitle: null,
        narrative: "A decision was made",
        facts: [],
        concepts: ["Decision", "Architecture"], // Mixed case
        filesRead: [],
        filesModified: [],
      };

      storeObservation(db, {
        claudeSessionId: "claude-123",
        project: "test-project",
        observation: obs,
        promptNumber: 1,
      });

      // Test case-insensitive matching (lowercase query)
      const result = searchObservations(db, {
        query: "decision",
        concept: "decision", // lowercase
        limit: 10,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveLength(1);
      }
    });

    it("returns empty results when concept doesn't match", () => {
      createSession(db, {
        claudeSessionId: "claude-123",
        project: "test-project",
        userPrompt: "Test",
      });

      const obs: ParsedObservation = {
        type: "feature",
        title: "Test feature",
        subtitle: null,
        narrative: "A feature was implemented",
        facts: [],
        concepts: ["feature"],
        filesRead: [],
        filesModified: [],
      };

      storeObservation(db, {
        claudeSessionId: "claude-123",
        project: "test-project",
        observation: obs,
        promptNumber: 1,
      });

      const result = searchObservations(db, {
        query: "feature",
        concept: "bugfix", // no observations have this concept
        limit: 10,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveLength(0);
      }
    });
  });

  describe("migration v5 — cross-project indexes", () => {
    it("creates idx_observations_concepts index", () => {
      const row = db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_observations_concepts'",
        )
        .get();
      expect(row).not.toBeNull();
      expect(row?.name).toBe("idx_observations_concepts");
    });

    it("creates idx_observations_project_epoch index", () => {
      const row = db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_observations_project_epoch'",
        )
        .get();
      expect(row).not.toBeNull();
      expect(row?.name).toBe("idx_observations_project_epoch");
    });
  });

  describe("getCandidateObservations (cross-project)", () => {
    it("returns observations from all projects", () => {
      // Store observations in two different projects
      createSession(db, {
        claudeSessionId: "sess-1",
        project: "project-a",
        userPrompt: "Test",
      });

      createSession(db, {
        claudeSessionId: "sess-2",
        project: "project-b",
        userPrompt: "Test",
      });

      storeObservation(db, {
        claudeSessionId: "sess-1",
        project: "project-a",
        observation: {
          type: "bugfix",
          title: "Fix auth bug",
          subtitle: null,
          narrative: "Fixed authentication timeout",
          facts: [],
          concepts: ["problem-solution"],
          filesRead: ["src/auth.ts"],
          filesModified: ["src/auth.ts"],
        },
        promptNumber: 1,
      });

      storeObservation(db, {
        claudeSessionId: "sess-2",
        project: "project-b",
        observation: {
          type: "discovery",
          title: "Found config issue",
          subtitle: null,
          narrative: "Config parsing fails on empty",
          facts: [],
          concepts: ["gotcha"],
          filesRead: ["src/config.ts"],
          filesModified: [],
        },
        promptNumber: 1,
      });

      const result = getCandidateObservations(db, { limit: 10 });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(2);
        const projects = result.value.map((o) => o.project);
        expect(projects).toContain("project-a");
        expect(projects).toContain("project-b");
      }
    });

    it("supports FTS keyword filtering", () => {
      // Each test needs its own data since beforeEach resets DB
      createSession(db, {
        claudeSessionId: "sess-1",
        project: "project-a",
        userPrompt: "Test",
      });

      storeObservation(db, {
        claudeSessionId: "sess-1",
        project: "project-a",
        observation: {
          type: "bugfix",
          title: "Fix auth bug",
          subtitle: null,
          narrative: "Fixed authentication timeout",
          facts: [],
          concepts: ["problem-solution"],
          filesRead: ["src/auth.ts"],
          filesModified: ["src/auth.ts"],
        },
        promptNumber: 1,
      });

      storeObservation(db, {
        claudeSessionId: "sess-1",
        project: "project-a",
        observation: {
          type: "discovery",
          title: "Found config issue",
          subtitle: null,
          narrative: "Config parsing fails on empty",
          facts: [],
          concepts: ["gotcha"],
          filesRead: ["src/config.ts"],
          filesModified: [],
        },
        promptNumber: 2,
      });

      const result = getCandidateObservations(db, {
        limit: 10,
        ftsQuery: '"auth"',
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBeGreaterThanOrEqual(1);
        expect(result.value[0].title).toContain("auth");
      }
    });

    it("returns ftsRank when FTS query provided", () => {
      // Each test needs its own data since beforeEach resets DB
      createSession(db, {
        claudeSessionId: "sess-1",
        project: "project-a",
        userPrompt: "Test",
      });

      storeObservation(db, {
        claudeSessionId: "sess-1",
        project: "project-a",
        observation: {
          type: "bugfix",
          title: "Fix auth bug",
          subtitle: null,
          narrative: "Fixed authentication timeout",
          facts: [],
          concepts: ["problem-solution"],
          filesRead: ["src/auth.ts"],
          filesModified: ["src/auth.ts"],
        },
        promptNumber: 1,
      });

      const result = getCandidateObservations(db, {
        limit: 10,
        ftsQuery: '"auth"',
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value[0]).toHaveProperty("ftsRank");
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
});
