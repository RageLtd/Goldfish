import { describe, expect, it } from "bun:test";
import {
	extractTagContent,
	extractTagList,
	parseObservations,
	parseSummary,
} from "../../src/sdk/parser";

describe("extractTagContent", () => {
	it("extracts content from a single tag", () => {
		const xml = "<title>Hello World</title>";
		expect(extractTagContent(xml, "title")).toBe("Hello World");
	});

	it("returns null when tag not found", () => {
		const xml = "<other>content</other>";
		expect(extractTagContent(xml, "title")).toBeNull();
	});

	it("handles multiline content", () => {
		const xml = `<narrative>
Line 1
Line 2
</narrative>`;
		expect(extractTagContent(xml, "narrative")).toBe("Line 1\nLine 2");
	});

	it("handles whitespace-only content", () => {
		const xml = "<title>   </title>";
		expect(extractTagContent(xml, "title")).toBeNull();
	});

	it("extracts first occurrence when multiple exist", () => {
		const xml = "<title>First</title><title>Second</title>";
		expect(extractTagContent(xml, "title")).toBe("First");
	});
});

describe("extractTagList", () => {
	it("extracts list of items from repeated tags", () => {
		const xml = `<facts>
      <fact>Fact one</fact>
      <fact>Fact two</fact>
    </facts>`;
		expect(extractTagList(xml, "facts", "fact")).toEqual([
			"Fact one",
			"Fact two",
		]);
	});

	it("returns empty array when container not found", () => {
		const xml = "<other>content</other>";
		expect(extractTagList(xml, "facts", "fact")).toEqual([]);
	});

	it("returns empty array when no items in container", () => {
		const xml = "<facts></facts>";
		expect(extractTagList(xml, "facts", "fact")).toEqual([]);
	});

	it("filters out empty items", () => {
		const xml = `<facts>
      <fact>Valid</fact>
      <fact>   </fact>
      <fact></fact>
    </facts>`;
		expect(extractTagList(xml, "facts", "fact")).toEqual(["Valid"]);
	});
});

describe("parseObservations", () => {
	it("parses a complete observation", () => {
		const xml = `
<observation>
  <type>feature</type>
  <title>Added user authentication</title>
  <subtitle>Implemented JWT-based auth flow</subtitle>
  <narrative>Full implementation of authentication system.</narrative>
  <facts>
    <fact>Uses JWT tokens</fact>
    <fact>Supports refresh tokens</fact>
  </facts>
  <concepts>
    <concept>how-it-works</concept>
    <concept>pattern</concept>
  </concepts>
  <files_read>
    <file>auth.ts</file>
  </files_read>
  <files_modified>
    <file>user.ts</file>
    <file>routes.ts</file>
  </files_modified>
</observation>`;

		const result = parseObservations(xml);

		expect(result).toHaveLength(1);
		expect(result[0]).toEqual({
			type: "feature",
			title: "Added user authentication",
			subtitle: "Implemented JWT-based auth flow",
			narrative: "Full implementation of authentication system.",
			facts: ["Uses JWT tokens", "Supports refresh tokens"],
			concepts: ["how-it-works", "pattern"],
			filesRead: ["auth.ts"],
			filesModified: ["user.ts", "routes.ts"],
		});
	});

	it("parses multiple observations", () => {
		const xml = `
<observation>
  <type>bugfix</type>
  <title>Fix #1</title>
</observation>
<observation>
  <type>feature</type>
  <title>Feature #1</title>
</observation>`;

		const result = parseObservations(xml);

		expect(result).toHaveLength(2);
		expect(result[0].type).toBe("bugfix");
		expect(result[1].type).toBe("feature");
	});

	it('defaults to "change" for invalid type', () => {
		const xml = `
<observation>
  <type>invalid_type</type>
  <title>Some change</title>
</observation>`;

		const result = parseObservations(xml);

		expect(result[0].type).toBe("change");
	});

	it('defaults to "change" for missing type', () => {
		const xml = `
<observation>
  <title>Some change</title>
</observation>`;

		const result = parseObservations(xml);

		expect(result[0].type).toBe("change");
	});

	it("handles observation with minimal fields", () => {
		const xml = "<observation></observation>";

		const result = parseObservations(xml);

		expect(result).toHaveLength(1);
		expect(result[0]).toEqual({
			type: "change",
			title: null,
			subtitle: null,
			narrative: null,
			facts: [],
			concepts: [],
			filesRead: [],
			filesModified: [],
		});
	});

	it("filters observation type from concepts", () => {
		const xml = `
<observation>
  <type>discovery</type>
  <concepts>
    <concept>discovery</concept>
    <concept>how-it-works</concept>
  </concepts>
</observation>`;

		const result = parseObservations(xml);

		// 'discovery' should be filtered out since it matches the type
		expect(result[0].concepts).toEqual(["how-it-works"]);
	});

	it("returns empty array when no observations found", () => {
		const xml = "Just some text without observations";

		expect(parseObservations(xml)).toEqual([]);
	});

	it("handles surrounding text", () => {
		const xml = `
Some preamble text

<observation>
  <type>bugfix</type>
  <title>Fixed issue</title>
</observation>

Some trailing text
`;

		const result = parseObservations(xml);

		expect(result).toHaveLength(1);
		expect(result[0].title).toBe("Fixed issue");
	});
});

describe("parseSummary", () => {
	it("parses a complete summary", () => {
		const xml = `
<summary>
  <request>Implement user authentication</request>
  <investigated>Existing auth patterns in codebase</investigated>
  <learned>The app uses JWT for token management</learned>
  <completed>Basic auth flow with login/logout</completed>
  <next_steps>Add password reset functionality</next_steps>
  <notes>Consider adding OAuth support later</notes>
</summary>`;

		const result = parseSummary(xml);

		expect(result).toEqual({
			request: "Implement user authentication",
			investigated: "Existing auth patterns in codebase",
			learned: "The app uses JWT for token management",
			completed: "Basic auth flow with login/logout",
			nextSteps: "Add password reset functionality",
			notes: "Consider adding OAuth support later",
		});
	});

	it("returns null when no summary found", () => {
		const xml = "No summary here";

		expect(parseSummary(xml)).toBeNull();
	});

	it("handles partial summary", () => {
		const xml = `
<summary>
  <request>Do something</request>
  <completed>Did something</completed>
</summary>`;

		const result = parseSummary(xml);

		expect(result).toEqual({
			request: "Do something",
			investigated: null,
			learned: null,
			completed: "Did something",
			nextSteps: null,
			notes: null,
		});
	});

	it("handles empty summary tags", () => {
		const xml = "<summary></summary>";

		const result = parseSummary(xml);

		expect(result).toEqual({
			request: null,
			investigated: null,
			learned: null,
			completed: null,
			nextSteps: null,
			notes: null,
		});
	});
});
