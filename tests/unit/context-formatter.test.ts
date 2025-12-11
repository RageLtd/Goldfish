import { describe, expect, it } from "bun:test";
import type { Observation, SessionSummary } from "../../src/types/domain";
import {
	estimateIndexTokens,
	estimateObservationTokens,
	estimateSummaryTokens,
	estimateTokens,
	formatBudgetSummary,
	formatContextFull,
	formatContextIndex,
	formatObservationFull,
	formatObservationIndexRow,
	formatSummaryIndexRow,
	groupByDate,
	groupByFile,
	TYPE_ICONS,
} from "../../src/utils/context-formatter";

const createMockObservation = (
	overrides: Partial<Observation> = {},
): Observation => ({
	id: 1,
	sdkSessionId: "test-session",
	project: "test-project",
	type: "discovery",
	title: "Test Observation",
	subtitle: "A test subtitle",
	narrative: "This is a test narrative",
	facts: ["fact1", "fact2"],
	concepts: ["concept1", "concept2"],
	filesRead: ["/path/to/file.ts"],
	filesModified: [],
	discoveryTokens: 1000,
	createdAtEpoch: Date.now(),
	...overrides,
});

const createMockSummary = (
	overrides: Partial<SessionSummary> = {},
): SessionSummary => ({
	id: 1,
	sdkSessionId: "test-session",
	project: "test-project",
	request: "Test request",
	investigated: "Investigated something",
	learned: "Learned something",
	completed: "Completed something",
	nextSteps: "Next steps",
	notes: "Some notes",
	discoveryTokens: 500,
	createdAtEpoch: Date.now(),
	...overrides,
});

describe("TYPE_ICONS", () => {
	it("has icons for all observation types", () => {
		expect(TYPE_ICONS.decision).toBeDefined();
		expect(TYPE_ICONS.bugfix).toBeDefined();
		expect(TYPE_ICONS.feature).toBeDefined();
		expect(TYPE_ICONS.refactor).toBeDefined();
		expect(TYPE_ICONS.discovery).toBeDefined();
		expect(TYPE_ICONS.change).toBeDefined();
		expect(TYPE_ICONS.session).toBeDefined();
	});
});

describe("estimateTokens", () => {
	it("returns 0 for null/undefined/empty", () => {
		expect(estimateTokens(null)).toBe(0);
		expect(estimateTokens(undefined)).toBe(0);
		expect(estimateTokens("")).toBe(0);
	});

	it("estimates ~4 chars per token", () => {
		expect(estimateTokens("1234")).toBe(1);
		expect(estimateTokens("12345678")).toBe(2);
		expect(estimateTokens("123456789012")).toBe(3);
	});

	it("rounds up", () => {
		expect(estimateTokens("12345")).toBe(2); // 5/4 = 1.25 -> 2
	});
});

describe("estimateObservationTokens", () => {
	it("sums tokens from all fields", () => {
		const obs = createMockObservation();
		const tokens = estimateObservationTokens(obs);
		expect(tokens).toBeGreaterThan(0);
	});

	it("handles empty arrays", () => {
		const obs = createMockObservation({
			facts: [],
			concepts: [],
			filesRead: [],
			filesModified: [],
		});
		const tokens = estimateObservationTokens(obs);
		expect(tokens).toBeGreaterThan(0); // Still has title, subtitle, narrative
	});
});

describe("estimateSummaryTokens", () => {
	it("sums tokens from all fields", () => {
		const summary = createMockSummary();
		const tokens = estimateSummaryTokens(summary);
		expect(tokens).toBeGreaterThan(0);
	});
});

describe("estimateIndexTokens", () => {
	it("estimates lightweight index size", () => {
		const observations = [createMockObservation(), createMockObservation()];
		const summaries = [createMockSummary()];

		const tokens = estimateIndexTokens(observations, summaries);

		// ~20 tokens per observation + ~15 per summary + overhead
		expect(tokens).toBeGreaterThan(0);
		expect(tokens).toBeLessThan(500); // Should be lightweight
	});
});

describe("groupByDate", () => {
	it("groups observations into date buckets", () => {
		const now = Date.now();
		const yesterday = now - 86400000;
		const weekAgo = now - 86400000 * 5;
		const monthAgo = now - 86400000 * 30;

		const observations = [
			createMockObservation({ id: 1, createdAtEpoch: now }),
			createMockObservation({ id: 2, createdAtEpoch: yesterday }),
			createMockObservation({ id: 3, createdAtEpoch: weekAgo }),
			createMockObservation({ id: 4, createdAtEpoch: monthAgo }),
		];

		const groups = groupByDate(observations);

		expect(groups.length).toBeGreaterThan(0);
		// Should have Today, Yesterday, This Week, Older groups (non-empty ones)
		const labels = groups.map((g) => g.label);
		expect(labels).toContain("Today");
	});

	it("returns empty groups array for empty input", () => {
		const groups = groupByDate([]);
		expect(groups).toEqual([]);
	});
});

describe("groupByFile", () => {
	it("groups observations by primary file", () => {
		const observations = [
			createMockObservation({
				id: 1,
				filesModified: ["/path/a.ts"],
				filesRead: [],
			}),
			createMockObservation({
				id: 2,
				filesModified: ["/path/a.ts"],
				filesRead: [],
			}),
			createMockObservation({
				id: 3,
				filesModified: [],
				filesRead: ["/path/b.ts"],
			}),
		];

		const groups = groupByFile(observations);

		expect(groups.length).toBe(2);
		// Should be sorted by count (most active first)
		expect(groups[0].items.length).toBeGreaterThanOrEqual(
			groups[1].items.length,
		);
	});

	it("uses 'General' for observations without files", () => {
		const observations = [
			createMockObservation({
				id: 1,
				filesModified: [],
				filesRead: [],
			}),
		];

		const groups = groupByFile(observations);

		expect(groups[0].filePath).toBe("General");
	});
});

describe("formatObservationIndexRow", () => {
	it("formats observation as table row", () => {
		const obs = createMockObservation({
			id: 42,
			type: "decision",
			title: "Test Decision",
		});

		const row = formatObservationIndexRow(obs);

		expect(row).toContain("#42");
		expect(row).toContain("Test Decision");
		expect(row).toContain(TYPE_ICONS.decision);
	});

	it("uses default icon for unknown types", () => {
		const obs = createMockObservation({
			type: "unknown" as Observation["type"],
		});

		const row = formatObservationIndexRow(obs);
		expect(row).toContain("|"); // Still formatted as row
	});
});

describe("formatSummaryIndexRow", () => {
	it("formats summary as table row", () => {
		const summary = createMockSummary({
			id: 5,
			request: "Test request",
		});

		const row = formatSummaryIndexRow(summary);

		expect(row).toContain("#S5");
		expect(row).toContain("Test request");
		expect(row).toContain(TYPE_ICONS.session);
	});
});

describe("formatBudgetSummary", () => {
	it("includes token economics", () => {
		const observations = [createMockObservation({ discoveryTokens: 5000 })];
		const summaries = [createMockSummary({ discoveryTokens: 2000 })];

		const summary = formatBudgetSummary(observations, summaries);

		expect(summary).toContain("Context Economics");
		expect(summary).toContain("observations");
		expect(summary).toContain("Work investment");
	});
});

describe("formatContextIndex", () => {
	it("formats context as lightweight index", () => {
		const observations = [createMockObservation()];
		const summaries = [createMockSummary()];

		const output = formatContextIndex("test-project", observations, summaries);

		expect(output).toContain("test-project");
		expect(output).toContain("Legend");
		expect(output).toContain("Context Economics");
		expect(output).toContain("|"); // Table formatting
	});

	it("handles empty data", () => {
		const output = formatContextIndex("test-project", [], []);

		expect(output).toContain("test-project");
		// Should still have header/legend even without data
		expect(output).toContain("Legend");
	});
});

describe("formatContextFull", () => {
	it("formats context with full details", () => {
		const observations = [createMockObservation()];
		const summaries = [createMockSummary()];

		const output = formatContextFull("test-project", observations, summaries);

		expect(output).toContain("test-project");
		expect(output).toContain("Test Observation");
		expect(output).toContain("Test request");
	});
});

describe("formatObservationFull", () => {
	it("formats single observation with all details", () => {
		const obs = createMockObservation({
			id: 42,
			type: "decision",
			title: "Architecture Decision",
			subtitle: "About the database",
			narrative: "We decided to use PostgreSQL",
			facts: ["Fact 1", "Fact 2"],
			concepts: ["database", "postgresql"],
			filesRead: ["/path/to/schema.sql"],
			filesModified: ["/path/to/config.ts"],
		});

		const output = formatObservationFull(obs);

		expect(output).toContain("Architecture Decision");
		expect(output).toContain("decision");
		expect(output).toContain("#42");
		expect(output).toContain("About the database");
		expect(output).toContain("We decided to use PostgreSQL");
		expect(output).toContain("Fact 1");
		expect(output).toContain("database");
		expect(output).toContain("schema.sql");
		expect(output).toContain("config.ts");
	});

	it("handles minimal observation", () => {
		const obs = createMockObservation({
			subtitle: "",
			narrative: "",
			facts: [],
			concepts: [],
			filesRead: [],
			filesModified: [],
		});

		const output = formatObservationFull(obs);

		expect(output).toContain("Test Observation");
		// Should not include empty sections
		expect(output).not.toContain("Facts:");
		expect(output).not.toContain("Concepts:");
	});
});
