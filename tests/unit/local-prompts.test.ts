import { describe, expect, it } from "bun:test";
import {
  buildLocalObservationPrompt,
  buildLocalSummaryPrompt,
  buildLocalSystemPrompt,
  OBSERVATION_TOOL,
  SUMMARY_TOOL,
} from "../../src/models/prompts";

describe("local model prompts", () => {
  it("builds a system prompt with observer guidelines", () => {
    const prompt = buildLocalSystemPrompt();
    expect(prompt).toContain("observer");
    expect(prompt).toContain("bugfix");
    expect(prompt).toContain("discovery");
    // Should contain brevity instructions
    expect(prompt).toContain("concise");
    expect(prompt).toContain("under 80 characters");
    expect(prompt).toContain("under 200 words");
    // Should NOT contain XML format instructions
    expect(prompt).not.toContain("<observation>");
    expect(prompt).not.toContain("</observation>");
  });

  it("builds observation prompt from tool execution", () => {
    const prompt = buildLocalObservationPrompt({
      toolName: "Edit",
      toolInput: {
        file_path: "src/auth.ts",
        old_string: "foo",
        new_string: "bar",
      },
      toolResponse: "Applied edit",
      cwd: "/projects/app",
      occurredAt: "2026-02-14T12:00:00Z",
    });
    expect(prompt).toContain("Edit");
    expect(prompt).toContain("src/auth.ts");
    expect(prompt).toContain("Applied edit");
  });

  it("builds summary prompt with tool calling instruction", () => {
    const prompt = buildLocalSummaryPrompt({
      lastUserMessage: "Fix the auth bug",
      lastAssistantMessage: "I fixed it",
    });
    expect(prompt).toContain("Fix the auth bug");
    expect(prompt).toContain("create_summary");
  });

  it("exports observation tool definition with correct schema", () => {
    expect(OBSERVATION_TOOL.type).toBe("function");
    expect(OBSERVATION_TOOL.function.name).toBe("create_observation");
    const params = OBSERVATION_TOOL.function.parameters as Record<
      string,
      Record<string, Record<string, unknown>>
    >;
    const typeEnum = params.properties.type.enum as readonly string[];
    const required = params.required as readonly string[];
    expect(typeEnum).toContain("bugfix");
    expect(typeEnum).toContain("discovery");
    expect(required).toContain("type");
    expect(required).toContain("title");
    expect(required).toContain("narrative");
  });

  it("exports summary tool definition with correct schema", () => {
    expect(SUMMARY_TOOL.type).toBe("function");
    expect(SUMMARY_TOOL.function.name).toBe("create_summary");
    const params = SUMMARY_TOOL.function.parameters as Record<
      string,
      Record<string, unknown>
    >;
    const properties = params.properties as Record<string, unknown>;
    expect(properties).toHaveProperty("request");
    expect(properties).toHaveProperty("investigated");
    expect(properties).toHaveProperty("learned");
    expect(properties).toHaveProperty("completed");
    expect(properties).toHaveProperty("nextSteps");
    expect(properties).toHaveProperty("notes");
    const required = params.required as readonly string[];
    expect(required).toEqual([]);
  });
});
