import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  createDatabase,
  createSession,
  getCandidateObservations,
  runMigrations,
  searchObservations,
  storeObservation,
} from "../../src/db/index";
import type { ParsedObservation } from "../../src/types/domain";

describe("database search", () => {
  let db: Database;

  beforeEach(() => {
    // Use in-memory database for tests
    db = createDatabase(":memory:");
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
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
});
