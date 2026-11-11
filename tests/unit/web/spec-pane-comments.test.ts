import { describe, expect, it } from "bun:test";
import { emphasizeEars, withoutHtmlComments } from "../../../src/web/components/spec/spec-pane.tsx";

describe("withoutHtmlComments", () => {
  it("drops the templates' notes but keeps code blocks as written", () => {
    const md = "## Testing\n<!-- for the AI -->\nText\n```html\n<!-- kept -->\n```\nAfter <!-- inline --> end\n";
    expect(withoutHtmlComments(md)).toBe("## Testing\nText\n```html\n<!-- kept -->\n```\nAfter  end\n");
  });
});

describe("emphasizeEars", () => {
  it("bolds EARS keywords in list items only, never in code or words that merely contain them", () => {
    const md = [
      "WHEN this paragraph is prose it stays as written",
      "1. WHEN the user opens History THE SYSTEM SHALL show `WHEN` as code",
      "2. IF an image fails THEN the export SHALL keep a placeholder",
      "- **WHEN** already bold, WHENEVER is a word",
      "```",
      "1. WHEN inside a fence",
      "```",
    ].join("\n");
    expect(emphasizeEars(md).split("\n")).toEqual([
      "WHEN this paragraph is prose it stays as written",
      "1. **WHEN** the user opens History **THE SYSTEM SHALL** show `WHEN` as code",
      "2. **IF** an image fails **THEN** the export **SHALL** keep a placeholder",
      "- **WHEN** already bold, WHENEVER is a word",
      "```",
      "1. WHEN inside a fence",
      "```",
    ]);
  });
});
