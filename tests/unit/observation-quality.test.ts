import { describe, expect, it } from "bun:test";
import type { Observation } from "../../src/types/domain";
import {
  getLowValueReasons,
  isLowValueObservation,
  MIN_CONTENT_LENGTH,
} from "../../src/utils/observation-quality";

const makeObs = (overrides: Partial<Observation> = {}): Observation => ({
  id: 1,
  sdkSessionId: "sess-1",
  project: "test",
  type: "discovery",
  title: "A meaningful title here",
  subtitle: null,
  narrative: "A meaningful narrative that explains what happened",
  facts: ["some fact"],
  concepts: [],
  filesRead: ["src/foo.ts"],
  filesModified: [],
  promptNumber: 1,
  discoveryTokens: 50,
  createdAt: "2026-01-01T00:00:00.000Z",
  createdAtEpoch: 1735689600000,
  ...overrides,
});

describe("observation-quality", () => {
  describe("getLowValueReasons", () => {
    it("returns empty array for a well-formed observation", () => {
      const obs = makeObs();
      expect(getLowValueReasons(obs)).toEqual([]);
    });

    it("detects missing-title when title is null", () => {
      const obs = makeObs({ title: null });
      const reasons = getLowValueReasons(obs);
      expect(reasons).toContain("missing-title");
    });

    it("detects missing-title when title is blank", () => {
      const obs = makeObs({ title: "   " });
      const reasons = getLowValueReasons(obs);
      expect(reasons).toContain("missing-title");
    });

    it("detects missing-narrative when narrative is null", () => {
      const obs = makeObs({ narrative: null });
      const reasons = getLowValueReasons(obs);
      expect(reasons).toContain("missing-narrative");
    });

    it("detects too-short when combined content is under threshold", () => {
      const obs = makeObs({ title: "Hi", narrative: "Ok" });
      expect("Hi".length + "Ok".length).toBeLessThan(MIN_CONTENT_LENGTH);
      const reasons = getLowValueReasons(obs);
      expect(reasons).toContain("too-short");
    });

    it("does not flag too-short when combined content meets threshold", () => {
      const obs = makeObs({
        title: "A longer title",
        narrative: "With enough narrative",
      });
      const reasons = getLowValueReasons(obs);
      expect(reasons).not.toContain("too-short");
    });

    it("detects empty-change for type=change with no files or facts", () => {
      const obs = makeObs({
        type: "change",
        filesRead: [],
        filesModified: [],
        facts: [],
      });
      const reasons = getLowValueReasons(obs);
      expect(reasons).toContain("empty-change");
    });

    it("does not flag empty-change for non-change types", () => {
      const obs = makeObs({
        type: "discovery",
        filesRead: [],
        filesModified: [],
        facts: [],
      });
      const reasons = getLowValueReasons(obs);
      expect(reasons).not.toContain("empty-change");
    });

    it("detects no-references when title present but no files or facts", () => {
      const obs = makeObs({
        filesRead: [],
        filesModified: [],
        facts: [],
      });
      const reasons = getLowValueReasons(obs);
      expect(reasons).toContain("no-references");
    });

    it("does not flag no-references when title is blank", () => {
      const obs = makeObs({
        title: null,
        filesRead: [],
        filesModified: [],
        facts: [],
      });
      const reasons = getLowValueReasons(obs);
      expect(reasons).not.toContain("no-references");
    });

    it("does not flag no-references when files are present", () => {
      const obs = makeObs({
        filesRead: ["src/foo.ts"],
        facts: [],
      });
      const reasons = getLowValueReasons(obs);
      expect(reasons).not.toContain("no-references");
    });
  });

  describe("isLowValueObservation", () => {
    it("returns false for a well-formed observation", () => {
      expect(isLowValueObservation(makeObs())).toBe(false);
    });

    it("returns true when any low-value reason exists", () => {
      expect(isLowValueObservation(makeObs({ title: null }))).toBe(true);
    });
  });
});
