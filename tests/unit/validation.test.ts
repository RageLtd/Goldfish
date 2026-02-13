import { describe, expect, it } from "bun:test";
import {
  DEFAULT_LIMIT,
  escapeFts5Query,
  MAX_LIMIT,
  MIN_LIMIT,
  projectFromCwd,
  sanitizeLimit,
  sanitizeProject,
} from "../../src/utils/validation";

describe("sanitizeLimit", () => {
  it("returns default for invalid input", () => {
    expect(sanitizeLimit(undefined)).toBe(DEFAULT_LIMIT);
    expect(sanitizeLimit(null)).toBe(DEFAULT_LIMIT);
    expect(sanitizeLimit("invalid")).toBe(DEFAULT_LIMIT);
    expect(sanitizeLimit(NaN)).toBe(DEFAULT_LIMIT);
    expect(sanitizeLimit(Infinity)).toBe(DEFAULT_LIMIT);
  });

  it("clamps to bounds", () => {
    expect(sanitizeLimit(0)).toBe(MIN_LIMIT);
    expect(sanitizeLimit(-5)).toBe(MIN_LIMIT);
    expect(sanitizeLimit(1000)).toBe(MAX_LIMIT);
  });

  it("accepts valid numbers", () => {
    expect(sanitizeLimit(5)).toBe(5);
    expect(sanitizeLimit("10")).toBe(10);
    expect(sanitizeLimit(50.7)).toBe(50);
  });
});

describe("sanitizeProject", () => {
  it("returns unknown for invalid input", () => {
    expect(sanitizeProject(undefined)).toBe("unknown");
    expect(sanitizeProject(null)).toBe("unknown");
    expect(sanitizeProject("")).toBe("unknown");
    expect(sanitizeProject("   ")).toBe("unknown");
  });

  it("rejects path traversal attempts", () => {
    expect(sanitizeProject("../secret")).toBe("unknown");
    expect(sanitizeProject("foo/bar")).toBe("unknown");
    expect(sanitizeProject("foo\\bar")).toBe("unknown");
  });

  it("rejects special characters", () => {
    expect(sanitizeProject("foo.bar")).toBe("unknown");
    expect(sanitizeProject("foo@bar")).toBe("unknown");
    expect(sanitizeProject("foo bar")).toBe("unknown");
  });

  it("accepts valid project names", () => {
    expect(sanitizeProject("my-project")).toBe("my-project");
    expect(sanitizeProject("my_project")).toBe("my_project");
    expect(sanitizeProject("MyProject123")).toBe("MyProject123");
  });
});

describe("projectFromCwd", () => {
  it("extracts basename from path", () => {
    expect(projectFromCwd("/Users/test/projects/my-app")).toBe("my-app");
    expect(projectFromCwd("C:\\Users\\test\\my-app")).toBe("my-app");
  });

  it("returns unknown for invalid input", () => {
    expect(projectFromCwd("")).toBe("unknown");
    expect(projectFromCwd("/")).toBe("unknown");
  });
});

describe("projectFromCwd — git-aware", () => {
  it("uses git repo root name for a repo directory", () => {
    // We're running inside the claude-mem repo (or a worktree of it)
    const cwd = process.cwd();
    const result = projectFromCwd(cwd);
    // Should resolve to the main repo name, not a worktree leaf name
    expect(result).not.toBe("unknown");
    expect(result.length).toBeGreaterThan(0);
    // Local dir is "claude-mem-bun", CI checkout is "claude-mem"
    expect(result).toMatch(/^claude-mem/);
  });

  it("falls back to basename for non-git directories", () => {
    expect(projectFromCwd("/tmp/some-random-dir")).toBe("some-random-dir");
  });
});

describe("escapeFts5Query", () => {
  it("returns empty quotes for invalid input", () => {
    expect(escapeFts5Query("")).toBe('""');
    expect(escapeFts5Query(null as unknown as string)).toBe('""');
    expect(escapeFts5Query(undefined as unknown as string)).toBe('""');
  });

  it("wraps simple strings in quotes", () => {
    expect(escapeFts5Query("hello")).toBe('"hello"');
    expect(escapeFts5Query("authentication")).toBe('"authentication"');
  });

  it("handles file paths with dots and slashes", () => {
    expect(escapeFts5Query("login.ts")).toBe('"login.ts"');
    expect(escapeFts5Query("src/auth/user.ts")).toBe('"src/auth/user.ts"');
    expect(escapeFts5Query("C:\\Users\\test.ts")).toBe('"C:\\Users\\test.ts"');
  });

  it("escapes internal double quotes", () => {
    expect(escapeFts5Query('file"name.ts')).toBe('"file""name.ts"');
    expect(escapeFts5Query('"quoted"')).toBe('"""quoted"""');
  });

  it("neutralizes FTS5 operators", () => {
    // These operators should be treated as literals when quoted
    expect(escapeFts5Query("file AND other")).toBe('"file AND other"');
    expect(escapeFts5Query("file OR other")).toBe('"file OR other"');
    expect(escapeFts5Query("NOT file")).toBe('"NOT file"');
    expect(escapeFts5Query("file*")).toBe('"file*"');
    expect(escapeFts5Query("file^priority")).toBe('"file^priority"');
    expect(escapeFts5Query("file(version)")).toBe('"file(version)"');
    expect(escapeFts5Query("column:value")).toBe('"column:value"');
  });

  it("handles complex edge cases", () => {
    expect(escapeFts5Query('path/to/"quoted"/file.ts')).toBe(
      '"path/to/""quoted""/file.ts"',
    );
    expect(escapeFts5Query("file-name_v2.test.ts")).toBe(
      '"file-name_v2.test.ts"',
    );
  });
});
