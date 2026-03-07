import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  deleteMapEntry,
  getDirectoryMap,
  getFileMap,
  getMapEntry,
  getMapStats,
  getStaleEntries,
  searchMap,
  upsertMapEntry,
} from "../../src/db/codebase-map";
import { createDatabase, runMigrations } from "../../src/db/index";

describe("codebase map", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  describe("upsertMapEntry", () => {
    it("inserts a new directory entry", () => {
      const result = upsertMapEntry(db, {
        project: "test-proj",
        path: "src/hooks",
        type: "directory",
        summary: "Hook lifecycle logic",
        fileHash: null,
      });

      expect(result.ok).toBe(true);
      expect(result.ok && result.value).toBeGreaterThan(0);
    });

    it("inserts a new file entry", () => {
      const result = upsertMapEntry(db, {
        project: "test-proj",
        path: "src/hooks/logic.ts",
        type: "file",
        summary: null,
        fileHash: "abc123",
      });

      expect(result.ok).toBe(true);
    });

    it("upserts on conflict (same project + path)", () => {
      upsertMapEntry(db, {
        project: "test-proj",
        path: "src/hooks",
        type: "directory",
        summary: "Old summary",
        fileHash: null,
      });

      upsertMapEntry(db, {
        project: "test-proj",
        path: "src/hooks",
        type: "directory",
        summary: "Updated summary",
        fileHash: null,
      });

      const entry = getMapEntry(db, "test-proj", "src/hooks");
      expect(entry.ok).toBe(true);
      if (entry.ok && entry.value) {
        expect(entry.value.summary).toBe("Updated summary");
      }
    });
  });

  describe("getDirectoryMap", () => {
    it("returns only directory entries sorted by path", () => {
      upsertMapEntry(db, {
        project: "proj",
        path: "src/worker",
        type: "directory",
        summary: "Worker service",
        fileHash: null,
      });
      upsertMapEntry(db, {
        project: "proj",
        path: "src/hooks",
        type: "directory",
        summary: "Hook logic",
        fileHash: null,
      });
      upsertMapEntry(db, {
        project: "proj",
        path: "src/hooks/logic.ts",
        type: "file",
        summary: null,
        fileHash: "abc",
      });

      const result = getDirectoryMap(db, "proj");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveLength(2);
        expect(result.value[0].path).toBe("src/hooks");
        expect(result.value[1].path).toBe("src/worker");
      }
    });

    it("filters by project", () => {
      upsertMapEntry(db, {
        project: "proj-a",
        path: "src",
        type: "directory",
        summary: "Source",
        fileHash: null,
      });
      upsertMapEntry(db, {
        project: "proj-b",
        path: "src",
        type: "directory",
        summary: "Other",
        fileHash: null,
      });

      const result = getDirectoryMap(db, "proj-a");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveLength(1);
        expect(result.value[0].summary).toBe("Source");
      }
    });
  });

  describe("getFileMap", () => {
    beforeEach(() => {
      upsertMapEntry(db, {
        project: "proj",
        path: "src/hooks/logic.ts",
        type: "file",
        summary: null,
        fileHash: "aaa",
      });
      upsertMapEntry(db, {
        project: "proj",
        path: "src/hooks/runner.ts",
        type: "file",
        summary: null,
        fileHash: "bbb",
      });
      upsertMapEntry(db, {
        project: "proj",
        path: "src/worker/service.ts",
        type: "file",
        summary: null,
        fileHash: "ccc",
      });
    });

    it("returns all files when no directory specified", () => {
      const result = getFileMap(db, "proj");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveLength(3);
      }
    });

    it("filters files by directory", () => {
      const result = getFileMap(db, "proj", "src/hooks");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveLength(2);
        expect(result.value[0].path).toBe("src/hooks/logic.ts");
        expect(result.value[1].path).toBe("src/hooks/runner.ts");
      }
    });

    it("does not include files from nested subdirectories", () => {
      upsertMapEntry(db, {
        project: "proj",
        path: "src/hooks/sub/deep.ts",
        type: "file",
        summary: null,
        fileHash: "ddd",
      });

      const result = getFileMap(db, "proj", "src/hooks");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveLength(2);
      }
    });
  });

  describe("searchMap", () => {
    it("finds entries by summary FTS", () => {
      upsertMapEntry(db, {
        project: "proj",
        path: "src/auth",
        type: "directory",
        summary: "Authentication and authorization handlers",
        fileHash: null,
      });
      upsertMapEntry(db, {
        project: "proj",
        path: "src/db",
        type: "directory",
        summary: "Database operations and migrations",
        fileHash: null,
      });

      const result = searchMap(db, "proj", "authentication");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveLength(1);
        expect(result.value[0].path).toBe("src/auth");
      }
    });

    it("finds entries by path FTS", () => {
      upsertMapEntry(db, {
        project: "proj",
        path: "src/worker/handlers",
        type: "directory",
        summary: "HTTP route handling",
        fileHash: null,
      });

      const result = searchMap(db, "proj", "handlers");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveLength(1);
      }
    });
  });

  describe("getStaleEntries", () => {
    it("identifies entries with changed hashes", () => {
      upsertMapEntry(db, {
        project: "proj",
        path: "src/a.ts",
        type: "file",
        summary: null,
        fileHash: "old-hash",
      });
      upsertMapEntry(db, {
        project: "proj",
        path: "src/b.ts",
        type: "file",
        summary: null,
        fileHash: "unchanged",
      });

      const currentHashes = new Map([
        ["src/a.ts", "new-hash"],
        ["src/b.ts", "unchanged"],
      ]);

      const result = getStaleEntries(db, "proj", currentHashes);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveLength(1);
        expect(result.value[0].path).toBe("src/a.ts");
      }
    });

    it("identifies deleted files as stale", () => {
      upsertMapEntry(db, {
        project: "proj",
        path: "src/deleted.ts",
        type: "file",
        summary: null,
        fileHash: "some-hash",
      });

      const currentHashes = new Map<string, string>();

      const result = getStaleEntries(db, "proj", currentHashes);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveLength(1);
        expect(result.value[0].path).toBe("src/deleted.ts");
      }
    });
  });

  describe("deleteMapEntry", () => {
    it("deletes an entry and its FTS content", () => {
      upsertMapEntry(db, {
        project: "proj",
        path: "src/old",
        type: "directory",
        summary: "To be deleted",
        fileHash: null,
      });

      const result = deleteMapEntry(db, "proj", "src/old");
      expect(result.ok).toBe(true);

      const entry = getMapEntry(db, "proj", "src/old");
      expect(entry.ok).toBe(true);
      if (entry.ok) {
        expect(entry.value).toBeNull();
      }
    });
  });

  describe("getMapStats", () => {
    it("returns correct counts", () => {
      upsertMapEntry(db, {
        project: "proj",
        path: "src/hooks",
        type: "directory",
        summary: "Hooks",
        fileHash: null,
      });
      upsertMapEntry(db, {
        project: "proj",
        path: "src/worker",
        type: "directory",
        summary: null,
        fileHash: null,
      });
      upsertMapEntry(db, {
        project: "proj",
        path: "src/hooks/logic.ts",
        type: "file",
        summary: null,
        fileHash: "abc",
      });

      const result = getMapStats(db, "proj");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.directories).toBe(2);
        expect(result.value.files).toBe(1);
        expect(result.value.withSummary).toBe(1);
      }
    });
  });
});
