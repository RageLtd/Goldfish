import { describe, expect, it } from "bun:test";
import {
  formatDate,
  formatDateTime,
  formatTime,
  getRelativeLabel,
  getStartOfDay,
  getStartOfWeek,
  parseSince,
} from "../../src/utils/temporal";

const MS_PER_DAY = 86400000;
const MS_PER_WEEK = MS_PER_DAY * 7;

describe("parseSince", () => {
  it("returns null for invalid input", () => {
    expect(parseSince(undefined)).toBe(null);
    expect(parseSince("")).toBe(null);
    expect(parseSince("invalid")).toBe(null);
    expect(parseSince("abc123")).toBe(null);
  });

  it("parses 'today' keyword", () => {
    const result = parseSince("today");
    const expected = getStartOfDay(new Date());
    expect(result).toBe(expected);
  });

  it("parses 'yesterday' keyword", () => {
    const result = parseSince("yesterday");
    const expected = getStartOfDay(new Date()) - MS_PER_DAY;
    expect(result).toBe(expected);
  });

  it("parses relative days (Nd)", () => {
    const result7d = parseSince("7d");
    const result30d = parseSince("30d");

    expect(result7d).not.toBe(null);
    expect(result30d).not.toBe(null);

    // Should be roughly 7 days ago
    const sevenDaysAgo = Date.now() - 7 * MS_PER_DAY;
    expect(Math.abs((result7d as number) - sevenDaysAgo)).toBeLessThan(1000);
  });

  it("parses relative weeks (Nw)", () => {
    const result2w = parseSince("2w");

    expect(result2w).not.toBe(null);

    // Should be roughly 2 weeks ago
    const twoWeeksAgo = Date.now() - 2 * MS_PER_WEEK;
    expect(Math.abs((result2w as number) - twoWeeksAgo)).toBeLessThan(1000);
  });

  it("rejects out-of-range values", () => {
    expect(parseSince("0d")).toBe(null);
    expect(parseSince("366d")).toBe(null);
    expect(parseSince("0w")).toBe(null);
    expect(parseSince("53w")).toBe(null);
  });

  it("parses epoch timestamps", () => {
    // 10-digit (seconds)
    const seconds = parseSince("1704067200");
    expect(seconds).toBe(1704067200000); // Normalized to milliseconds

    // 13-digit (milliseconds)
    const millis = parseSince("1704067200000");
    expect(millis).toBe(1704067200000);
  });

  it("parses ISO date strings", () => {
    const result = parseSince("2024-01-15");
    expect(result).not.toBe(null);

    const date = new Date("2024-01-15");
    expect(result).toBe(date.getTime());
  });

  it("is case insensitive for keywords", () => {
    expect(parseSince("TODAY")).toBe(parseSince("today"));
    expect(parseSince("Yesterday")).toBe(parseSince("yesterday"));
    expect(parseSince("7D")).toBe(parseSince("7d"));
  });

  it("trims whitespace", () => {
    expect(parseSince("  today  ")).toBe(parseSince("today"));
    expect(parseSince("  7d  ")).toBe(parseSince("7d"));
  });
});

describe("getStartOfDay", () => {
  it("returns midnight for a date", () => {
    const date = new Date("2024-01-15T14:30:00");
    const result = getStartOfDay(date);
    const resultDate = new Date(result);

    expect(resultDate.getHours()).toBe(0);
    expect(resultDate.getMinutes()).toBe(0);
    expect(resultDate.getSeconds()).toBe(0);
    expect(resultDate.getMilliseconds()).toBe(0);
  });
});

describe("getStartOfWeek", () => {
  it("returns Sunday for a date", () => {
    // Wednesday Jan 17, 2024
    const date = new Date("2024-01-17T14:30:00");
    const result = getStartOfWeek(date);
    const resultDate = new Date(result);

    // Should be Sunday Jan 14, 2024
    expect(resultDate.getDay()).toBe(0); // Sunday
    expect(resultDate.getDate()).toBe(14);
  });
});

describe("getRelativeLabel", () => {
  it("returns 'Today' for today", () => {
    const now = Date.now();
    expect(getRelativeLabel(now)).toBe("Today");
  });

  it("returns 'Yesterday' for yesterday", () => {
    const yesterday = Date.now() - MS_PER_DAY;
    expect(getRelativeLabel(yesterday)).toBe("Yesterday");
  });

  it("returns 'This Week' for recent dates", () => {
    const threeDaysAgo = Date.now() - 3 * MS_PER_DAY;
    // Only if it's not older than a week
    const label = getRelativeLabel(threeDaysAgo);
    expect(["This Week", "Yesterday", "Today"]).toContain(label);
  });

  it("returns 'Older' for old dates", () => {
    const twoWeeksAgo = Date.now() - 2 * MS_PER_WEEK;
    expect(getRelativeLabel(twoWeeksAgo)).toBe("Older");
  });
});

describe("formatDate", () => {
  it("formats date in en-US locale", () => {
    const date = new Date("2024-01-15T00:00:00").getTime();
    const result = formatDate(date);

    // Should contain Jan, 15, 2024
    expect(result).toContain("Jan");
    expect(result).toContain("15");
    expect(result).toContain("2024");
  });
});

describe("formatTime", () => {
  it("formats time in 12-hour format", () => {
    const date = new Date("2024-01-15T14:30:00").getTime();
    const result = formatTime(date);

    // Should be 2:30 PM
    expect(result).toContain("2");
    expect(result).toContain("30");
    expect(result.toLowerCase()).toContain("pm");
  });
});

describe("formatDateTime", () => {
  it("formats date and time", () => {
    const date = new Date("2024-01-15T14:30:00").getTime();
    const result = formatDateTime(date);

    // Should contain both date and time
    expect(result).toContain("Jan");
    expect(result).toContain("15");
    expect(result).toContain("2");
    expect(result).toContain("30");
  });
});
