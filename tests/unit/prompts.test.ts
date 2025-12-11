import { describe, expect, it } from "bun:test";
import {
	buildContinuationPrompt,
	buildInitPrompt,
	buildObservationPrompt,
	buildSummaryPrompt,
} from "../../src/sdk/prompts";
import type { ToolObservation } from "../../src/types/domain";

describe("buildInitPrompt", () => {
	it("includes project name", () => {
		const prompt = buildInitPrompt({
			project: "my-project",
			sessionId: "session-123",
			userPrompt: "Help me fix a bug",
		});

		expect(prompt).toContain("my-project");
	});

	it("includes session ID", () => {
		const prompt = buildInitPrompt({
			project: "my-project",
			sessionId: "session-123",
			userPrompt: "Help me fix a bug",
		});

		expect(prompt).toContain("session-123");
	});

	it("includes user prompt", () => {
		const prompt = buildInitPrompt({
			project: "my-project",
			sessionId: "session-123",
			userPrompt: "Help me fix a bug",
		});

		expect(prompt).toContain("Help me fix a bug");
	});

	it("includes session context XML structure", () => {
		const prompt = buildInitPrompt({
			project: "my-project",
			sessionId: "session-123",
			userPrompt: "Help me fix a bug",
		});

		// Should include session context XML (observer instructions are now in SDK systemPrompt)
		expect(prompt).toContain("<session_context>");
		expect(prompt).toContain("</session_context>");
	});

	it("indicates session start and observation expectations", () => {
		const prompt = buildInitPrompt({
			project: "my-project",
			sessionId: "session-123",
			userPrompt: "Help me fix a bug",
		});

		// Should indicate session has started and observations are expected
		expect(prompt.toLowerCase()).toContain("session");
		expect(prompt.toLowerCase()).toContain("observation");
	});
});

describe("buildObservationPrompt", () => {
	const baseObservation: ToolObservation = {
		toolName: "Bash",
		toolInput: { command: "git status" },
		toolResponse: { stdout: "On branch main" },
		cwd: "/projects/test",
		occurredAt: "2025-01-15T10:30:00.000Z",
	};

	it("includes tool name", () => {
		const prompt = buildObservationPrompt(baseObservation);

		expect(prompt).toContain("Bash");
	});

	it("includes tool input as JSON", () => {
		const prompt = buildObservationPrompt(baseObservation);

		expect(prompt).toContain("git status");
	});

	it("includes tool response", () => {
		const prompt = buildObservationPrompt(baseObservation);

		expect(prompt).toContain("On branch main");
	});

	it("includes working directory", () => {
		const prompt = buildObservationPrompt(baseObservation);

		expect(prompt).toContain("/projects/test");
	});

	it("includes timestamp", () => {
		const prompt = buildObservationPrompt(baseObservation);

		expect(prompt).toContain("2025-01-15");
	});

	it("uses XML structure", () => {
		const prompt = buildObservationPrompt(baseObservation);

		expect(prompt).toContain("<observed_from_primary_session>");
		expect(prompt).toContain("</observed_from_primary_session>");
	});

	it("handles complex tool input", () => {
		const observation: ToolObservation = {
			...baseObservation,
			toolInput: {
				nested: { value: 123 },
				array: [1, 2, 3],
			},
		};

		const prompt = buildObservationPrompt(observation);

		expect(prompt).toContain("nested");
		expect(prompt).toContain("123");
	});

	it("handles null/undefined in response", () => {
		const observation: ToolObservation = {
			...baseObservation,
			toolResponse: null,
		};

		const prompt = buildObservationPrompt(observation);

		expect(prompt).toContain("null");
	});
});

describe("buildSummaryPrompt", () => {
	it("requests progress summary", () => {
		const prompt = buildSummaryPrompt({
			lastUserMessage: "Fix the authentication bug",
			lastAssistantMessage: "I fixed the bug by updating the token validation",
		});

		expect(prompt.toLowerCase()).toContain("summary");
	});

	it("includes last user message", () => {
		const prompt = buildSummaryPrompt({
			lastUserMessage: "Fix the authentication bug",
			lastAssistantMessage: "I fixed the bug",
		});

		expect(prompt).toContain("Fix the authentication bug");
	});

	it("includes expected summary XML structure", () => {
		const prompt = buildSummaryPrompt({
			lastUserMessage: "Task",
			lastAssistantMessage: "Done",
		});

		expect(prompt).toContain("<summary>");
		expect(prompt).toContain("<request>");
		expect(prompt).toContain("<completed>");
	});

	it("handles empty messages", () => {
		const prompt = buildSummaryPrompt({
			lastUserMessage: "",
			lastAssistantMessage: "",
		});

		// Should still produce valid prompt
		expect(prompt).toContain("<summary>");
	});
});

describe("buildContinuationPrompt", () => {
	it("includes prompt number", () => {
		const prompt = buildContinuationPrompt({
			userPrompt: "Continue working on the feature",
			promptNumber: 3,
			sessionId: "session-123",
		});

		expect(prompt).toContain("3");
	});

	it("includes user prompt", () => {
		const prompt = buildContinuationPrompt({
			userPrompt: "Continue working on the feature",
			promptNumber: 3,
			sessionId: "session-123",
		});

		expect(prompt).toContain("Continue working on the feature");
	});

	it("includes session ID for context", () => {
		const prompt = buildContinuationPrompt({
			userPrompt: "Continue",
			promptNumber: 2,
			sessionId: "session-123",
		});

		expect(prompt).toContain("session-123");
	});

	it("indicates continuation context", () => {
		const prompt = buildContinuationPrompt({
			userPrompt: "Continue",
			promptNumber: 5,
			sessionId: "session-123",
		});

		// Should indicate this is a continuation
		expect(prompt.toLowerCase()).toMatch(/continu|additional|follow/);
	});
});
