import { describe, expect, it } from "bun:test";
import {
  parseSearchToolCall,
  parseSummaryToolCall,
  parseToolCall,
} from "../../src/models/tool-call-parser";

describe("parseToolCall", () => {
  it("parses a valid tool call with all fields", () => {
    const input = `{"name": "create_observation", "arguments": {"type": "bugfix", "title": "Fixed async token bug", "subtitle": "Added missing await", "narrative": "The getToken call was missing await", "facts": ["getToken is async"], "concepts": ["problem-solution"]}}`;

    const result = parseToolCall(input);
    expect(result).not.toBeNull();
    expect(result?.name).toBe("create_observation");
    expect(result?.arguments.type).toBe("bugfix");
    expect(result?.arguments.title).toBe("Fixed async token bug");
    expect(result?.arguments.narrative).toBe(
      "The getToken call was missing await",
    );
    expect(result?.arguments.facts).toEqual(["getToken is async"]);
    expect(result?.arguments.concepts).toEqual(["problem-solution"]);
  });

  it("parses minimal required fields", () => {
    const input = `{"name": "create_observation", "arguments": {"type": "discovery", "title": "Found config pattern", "narrative": "The config uses a factory function"}}`;

    const result = parseToolCall(input);
    expect(result).not.toBeNull();
    expect(result?.arguments.type).toBe("discovery");
    expect(result?.arguments.subtitle).toBeUndefined();
    expect(result?.arguments.facts).toBeUndefined();
  });

  it("returns null when no tool call present (trivial skip)", () => {
    const input = "This tool execution is routine and does not need recording.";
    const result = parseToolCall(input);
    expect(result).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    const input = "{not valid json}";
    const result = parseToolCall(input);
    expect(result).toBeNull();
  });

  it("extracts tool call from text with surrounding content", () => {
    const input = `Let me analyze this.
{"name": "create_observation", "arguments": {"type": "bugfix", "title": "Fixed race condition", "narrative": "Concurrent requests caused data corruption"}}`;

    const result = parseToolCall(input);
    expect(result).not.toBeNull();
    expect(result?.arguments.type).toBe("bugfix");
  });

  it("validates observation type is a known enum value", () => {
    const input = `{"name": "create_observation", "arguments": {"type": "invalid_type", "title": "Test", "narrative": "Test"}}`;

    const result = parseToolCall(input);
    expect(result).not.toBeNull();
    expect(result?.arguments.type).toBe("change");
  });
});

describe("parseSummaryToolCall", () => {
  it("parses a valid summary tool call with all fields", () => {
    const input = `{"name": "create_summary", "arguments": {"request": "Fix auth bug", "investigated": "Token refresh flow", "learned": "PKCE is required", "completed": "Fixed token refresh", "nextSteps": "Add refresh rotation", "notes": "Affects all OAuth flows"}}`;

    const result = parseSummaryToolCall(input);
    expect(result).not.toBeNull();
    expect(result?.name).toBe("create_summary");
    expect(result?.arguments.request).toBe("Fix auth bug");
    expect(result?.arguments.investigated).toBe("Token refresh flow");
    expect(result?.arguments.learned).toBe("PKCE is required");
    expect(result?.arguments.completed).toBe("Fixed token refresh");
    expect(result?.arguments.nextSteps).toBe("Add refresh rotation");
    expect(result?.arguments.notes).toBe("Affects all OAuth flows");
  });

  it("parses partial fields (all optional)", () => {
    const input = `{"name": "create_summary", "arguments": {"request": "Add tests", "completed": "Added unit tests"}}`;

    const result = parseSummaryToolCall(input);
    expect(result).not.toBeNull();
    expect(result?.arguments.request).toBe("Add tests");
    expect(result?.arguments.completed).toBe("Added unit tests");
    expect(result?.arguments.investigated).toBeUndefined();
    expect(result?.arguments.learned).toBeUndefined();
    expect(result?.arguments.nextSteps).toBeUndefined();
    expect(result?.arguments.notes).toBeUndefined();
  });

  it("returns null when no tool call present", () => {
    const result = parseSummaryToolCall("Just some plain text response.");
    expect(result).toBeNull();
  });

  it("returns null when tool name is not create_summary", () => {
    const input = `{"name": "create_observation", "arguments": {"type": "feature", "title": "Test", "narrative": "Test"}}`;

    const result = parseSummaryToolCall(input);
    expect(result).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    const input = "{not valid}";
    const result = parseSummaryToolCall(input);
    expect(result).toBeNull();
  });

  it("ignores non-string argument values", () => {
    const input = `{"name": "create_summary", "arguments": {"request": "Fix bug", "completed": 42, "learned": true}}`;

    const result = parseSummaryToolCall(input);
    expect(result).not.toBeNull();
    expect(result?.arguments.request).toBe("Fix bug");
    expect(result?.arguments.completed).toBeUndefined();
    expect(result?.arguments.learned).toBeUndefined();
  });
});

describe("parseSearchToolCall", () => {
  it("parses a valid search_memory tool call", () => {
    const input = `{"name": "search_memory", "arguments": {"query": "authentication bug fix"}}`;

    const result = parseSearchToolCall(input);
    expect(result).not.toBeNull();
    expect(result?.name).toBe("search_memory");
    expect(result?.arguments.query).toBe("authentication bug fix");
  });

  it("trims whitespace from query", () => {
    const input = `{"name": "search_memory", "arguments": {"query": "  database refactor  "}}`;

    const result = parseSearchToolCall(input);
    expect(result).not.toBeNull();
    expect(result?.arguments.query).toBe("database refactor");
  });

  it("returns null when no tool call present", () => {
    const result = parseSearchToolCall(
      "This prompt is just a greeting, no search needed.",
    );
    expect(result).toBeNull();
  });

  it("returns null when tool name is not search_memory", () => {
    const input = `{"name": "create_observation", "arguments": {"type": "feature", "title": "Test", "narrative": "Test"}}`;

    const result = parseSearchToolCall(input);
    expect(result).toBeNull();
  });

  it("returns null when query is empty string", () => {
    const input = `{"name": "search_memory", "arguments": {"query": ""}}`;

    const result = parseSearchToolCall(input);
    expect(result).toBeNull();
  });

  it("returns null when query is only whitespace", () => {
    const input = `{"name": "search_memory", "arguments": {"query": "   "}}`;

    const result = parseSearchToolCall(input);
    expect(result).toBeNull();
  });

  it("returns null when query is not a string", () => {
    const input = `{"name": "search_memory", "arguments": {"query": 42}}`;

    const result = parseSearchToolCall(input);
    expect(result).toBeNull();
  });

  it("extracts tool call from text with surrounding content", () => {
    const input = `The user wants to know about error handling patterns.
{"name": "search_memory", "arguments": {"query": "error handling patterns"}}`;

    const result = parseSearchToolCall(input);
    expect(result).not.toBeNull();
    expect(result?.arguments.query).toBe("error handling patterns");
  });
});
