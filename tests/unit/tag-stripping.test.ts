import { describe, expect, it } from "bun:test";
import {
  cleanPrompt,
  isEntirelyPrivate,
  isLowSignalPrompt,
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
  it("removes goldfish-context tags", () => {
    const input = "Hello <goldfish-context>injected</goldfish-context> world";
    expect(stripContextTags(input)).toBe("Hello  world");
  });

  it("handles multiline context", () => {
    const input = `Start
<goldfish-context>
# Context
- item 1
- item 2
</goldfish-context>
End`;
    expect(stripContextTags(input)).toBe("Start\n\nEnd");
  });
});

describe("stripAllMemoryTags", () => {
  it("removes both private and context tags without trimming", () => {
    const input =
      "<private>secret</private> public <goldfish-context>ctx</goldfish-context>";
    expect(stripAllMemoryTags(input)).toBe(" public ");
  });

  it("preserves internal whitespace", () => {
    const input =
      "  <private>x</private>  hello  <goldfish-context>y</goldfish-context>  ";
    expect(stripAllMemoryTags(input)).toBe("    hello    ");
  });
});

describe("cleanPrompt", () => {
  it("strips tags and trims result", () => {
    const input =
      "  <private>x</private>  hello  <goldfish-context>y</goldfish-context>  ";
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

describe("isLowSignalPrompt", () => {
  // Affirmations and simple confirmations — should be low-signal
  it("detects 'yes' as low-signal", () => {
    expect(isLowSignalPrompt("yes")).toBe(true);
  });

  it("detects 'okay' as low-signal", () => {
    expect(isLowSignalPrompt("okay")).toBe(true);
  });

  it("detects 'ok' as low-signal", () => {
    expect(isLowSignalPrompt("ok")).toBe(true);
  });

  it("detects 'sure' as low-signal", () => {
    expect(isLowSignalPrompt("sure")).toBe(true);
  });

  it("detects 'go ahead' as low-signal", () => {
    expect(isLowSignalPrompt("go ahead")).toBe(true);
  });

  it("detects 'let's do it' as low-signal", () => {
    expect(isLowSignalPrompt("let's do it")).toBe(true);
  });

  it("detects 'sounds good' as low-signal", () => {
    expect(isLowSignalPrompt("sounds good")).toBe(true);
  });

  it("detects 'lgtm' as low-signal", () => {
    expect(isLowSignalPrompt("lgtm")).toBe(true);
  });

  it("detects 'thanks' as low-signal", () => {
    expect(isLowSignalPrompt("thanks")).toBe(true);
  });

  it("detects 'thank you' as low-signal", () => {
    expect(isLowSignalPrompt("thank you")).toBe(true);
  });

  it("detects 'proceed' as low-signal", () => {
    expect(isLowSignalPrompt("proceed")).toBe(true);
  });

  it("detects 'continue' as low-signal", () => {
    expect(isLowSignalPrompt("continue")).toBe(true);
  });

  it("detects 'do it' as low-signal", () => {
    expect(isLowSignalPrompt("do it")).toBe(true);
  });

  it("detects 'agreed' as low-signal", () => {
    expect(isLowSignalPrompt("agreed")).toBe(true);
  });

  it("detects 'correct' as low-signal", () => {
    expect(isLowSignalPrompt("correct")).toBe(true);
  });

  it("detects 'nope' as low-signal", () => {
    expect(isLowSignalPrompt("nope")).toBe(true);
  });

  // Case and punctuation insensitive
  it("is case-insensitive", () => {
    expect(isLowSignalPrompt("YES")).toBe(true);
    expect(isLowSignalPrompt("Sounds Good")).toBe(true);
  });

  it("ignores trailing punctuation", () => {
    expect(isLowSignalPrompt("yes!")).toBe(true);
    expect(isLowSignalPrompt("okay.")).toBe(true);
    expect(isLowSignalPrompt("sure!!")).toBe(true);
    expect(isLowSignalPrompt("lgtm!")).toBe(true);
  });

  it("ignores leading/trailing whitespace", () => {
    expect(isLowSignalPrompt("  yes  ")).toBe(true);
    expect(isLowSignalPrompt("\n ok \n")).toBe(true);
  });

  // Project-relevant prompts — should NOT be low-signal
  it("does not flag 'fix the bug' as low-signal", () => {
    expect(isLowSignalPrompt("fix the bug")).toBe(false);
  });

  it("does not flag 'refactor auth' as low-signal", () => {
    expect(isLowSignalPrompt("refactor auth")).toBe(false);
  });

  it("does not flag prompts with file paths as low-signal", () => {
    expect(isLowSignalPrompt("look at src/hooks/logic.ts")).toBe(false);
  });

  it("does not flag prompts with backticks as low-signal", () => {
    expect(isLowSignalPrompt("update the `processNewHook` function")).toBe(
      false,
    );
  });

  it("does not flag prompts with camelCase tokens as low-signal", () => {
    expect(isLowSignalPrompt("fix processNewHook")).toBe(false);
  });

  it("does not flag prompts with snake_case tokens as low-signal", () => {
    expect(isLowSignalPrompt("update user_prompt table")).toBe(false);
  });

  it("does not flag multi-sentence prompts as low-signal", () => {
    expect(
      isLowSignalPrompt("Yes, and also add error handling to the parser"),
    ).toBe(false);
  });

  it("flags slash commands as low-signal", () => {
    expect(isLowSignalPrompt("/commit")).toBe(true);
    expect(isLowSignalPrompt("/review-pr")).toBe(true);
    expect(isLowSignalPrompt("/status")).toBe(true);
  });

  it("does not flag empty string (already handled by isEntirelyPrivate)", () => {
    expect(isLowSignalPrompt("")).toBe(false);
  });

  // New patterns — single-char, filler, short questions, acknowledgments, navigation
  it("detects single-char responses as low-signal", () => {
    expect(isLowSignalPrompt("y")).toBe(true);
    expect(isLowSignalPrompt("n")).toBe(true);
    expect(isLowSignalPrompt("k")).toBe(true);
  });

  it("detects filler words as low-signal", () => {
    expect(isLowSignalPrompt("hmm")).toBe(true);
    expect(isLowSignalPrompt("hm")).toBe(true);
    expect(isLowSignalPrompt("ah")).toBe(true);
    expect(isLowSignalPrompt("oh")).toBe(true);
    expect(isLowSignalPrompt("mhm")).toBe(true);
  });

  it("detects short questions as low-signal", () => {
    expect(isLowSignalPrompt("what")).toBe(true);
    expect(isLowSignalPrompt("why")).toBe(true);
    expect(isLowSignalPrompt("how")).toBe(true);
    expect(isLowSignalPrompt("really")).toBe(true);
  });

  it("detects acknowledgments as low-signal", () => {
    expect(isLowSignalPrompt("noted")).toBe(true);
    expect(isLowSignalPrompt("done")).toBe(true);
    expect(isLowSignalPrompt("fixed")).toBe(true);
    expect(isLowSignalPrompt("merged")).toBe(true);
    expect(isLowSignalPrompt("pushed")).toBe(true);
    expect(isLowSignalPrompt("committed")).toBe(true);
  });

  it("detects navigation words as low-signal", () => {
    expect(isLowSignalPrompt("next")).toBe(true);
    expect(isLowSignalPrompt("back")).toBe(true);
    expect(isLowSignalPrompt("again")).toBe(true);
    expect(isLowSignalPrompt("more")).toBe(true);
  });

  // Short prompt threshold — prompts below GOLDFISH_MIN_PROMPT_WORDS (default 3) are low-signal
  it("flags short prompts below word threshold as low-signal", () => {
    expect(isLowSignalPrompt("fix it")).toBe(true); // 2 words < 3
    expect(isLowSignalPrompt("do that")).toBe(true); // 2 words < 3
  });

  it("does not flag prompts at or above word threshold", () => {
    expect(isLowSignalPrompt("fix the bug")).toBe(false); // 3 words >= 3
    expect(isLowSignalPrompt("add error handling")).toBe(false); // 3 words >= 3
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
