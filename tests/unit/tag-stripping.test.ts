import { describe, expect, it } from "bun:test";
import {
	cleanPrompt,
	isEntirelyPrivate,
	stripAllMemoryTags,
	stripContextTags,
	stripPrivateTags,
	stripSystemReminders,
} from "../../src/utils/tag-stripping";

describe("stripPrivateTags", () => {
	it("removes single private tag", () => {
		const input = "Hello <private>secret</private> world";
		expect(stripPrivateTags(input)).toBe("Hello  world");
	});

	it("removes multiple private tags", () => {
		const input = "<private>a</private> middle <private>b</private>";
		expect(stripPrivateTags(input)).toBe(" middle ");
	});

	it("handles multiline private content", () => {
		const input = `Before
<private>
line 1
line 2
</private>
After`;
		expect(stripPrivateTags(input)).toBe("Before\n\nAfter");
	});

	it("handles nested tags by removing all content to outermost closing tag", () => {
		const input = "<private>outer <private>inner</private> outer</private>";
		// Should remove everything from first <private> to LAST </private>
		expect(stripPrivateTags(input)).toBe("");
	});

	it("handles multiple separate private blocks", () => {
		const input = "<private>first</private> middle <private>second</private>";
		expect(stripPrivateTags(input)).toBe(" middle ");
	});

	it("returns original string when no private tags", () => {
		const input = "Hello world";
		expect(stripPrivateTags(input)).toBe("Hello world");
	});

	it("handles empty string", () => {
		expect(stripPrivateTags("")).toBe("");
	});
});

describe("stripContextTags", () => {
	it("removes claude-mem-context tags", () => {
		const input =
			"Hello <claude-mem-context>injected</claude-mem-context> world";
		expect(stripContextTags(input)).toBe("Hello  world");
	});

	it("handles multiline context", () => {
		const input = `Start
<claude-mem-context>
# Context
- item 1
- item 2
</claude-mem-context>
End`;
		expect(stripContextTags(input)).toBe("Start\n\nEnd");
	});
});

describe("stripAllMemoryTags", () => {
	it("removes both private and context tags without trimming", () => {
		const input =
			"<private>secret</private> public <claude-mem-context>ctx</claude-mem-context>";
		expect(stripAllMemoryTags(input)).toBe(" public ");
	});

	it("preserves internal whitespace", () => {
		const input =
			"  <private>x</private>  hello  <claude-mem-context>y</claude-mem-context>  ";
		expect(stripAllMemoryTags(input)).toBe("    hello    ");
	});
});

describe("cleanPrompt", () => {
	it("strips tags and trims result", () => {
		const input =
			"  <private>x</private>  hello  <claude-mem-context>y</claude-mem-context>  ";
		expect(cleanPrompt(input)).toBe("hello");
	});

	it("collapses multiple spaces to single space", () => {
		const input = "<private>a</private>   text   <private>b</private>";
		expect(cleanPrompt(input)).toBe("text");
	});
});

describe("isEntirelyPrivate", () => {
	it("returns true when entire content is private", () => {
		expect(isEntirelyPrivate("<private>everything</private>")).toBe(true);
	});

	it("returns true when only whitespace remains after stripping", () => {
		expect(isEntirelyPrivate("  <private>all</private>  ")).toBe(true);
	});

	it("returns false when public content exists", () => {
		expect(isEntirelyPrivate("<private>secret</private> public")).toBe(false);
	});

	it("returns true for empty string", () => {
		expect(isEntirelyPrivate("")).toBe(true);
	});

	it("returns true for whitespace only", () => {
		expect(isEntirelyPrivate("   ")).toBe(true);
	});
});

describe("stripSystemReminders", () => {
	it("removes system-reminder tags", () => {
		const input = "Content <system-reminder>reminder</system-reminder> more";
		expect(stripSystemReminders(input)).toBe("Content  more");
	});

	it("handles multiline system reminders", () => {
		const input = `Response
<system-reminder>
This is a system reminder
with multiple lines
</system-reminder>
End`;
		expect(stripSystemReminders(input)).toBe("Response\n\nEnd");
	});
});
