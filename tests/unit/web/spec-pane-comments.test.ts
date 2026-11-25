import { describe, expect, it } from "bun:test";
import { emphasizeEars, specDocumentStatus, withoutHtmlComments } from "../../../src/web/components/spec/spec-pane.tsx";

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

describe("specDocumentStatus", () => {
  const ph = (over: Partial<Parameters<typeof specDocumentStatus>[0]>) =>
    ({ status: "draft", file: "specs/x/design.md", issues: [], text: "", submitted: false, approveBlocked: null, ...over }) as Parameters<typeof specDocumentStatus>[0];

  it("says what an approval still waits for", () => {
    expect(specDocumentStatus(ph({ approveBlocked: "Approve the UI drawing first (UI: yes)." })))
      .toBe("Draft · the AI has not submitted it yet · Approve the UI drawing first (UI: yes).");
    expect(specDocumentStatus(ph({ submitted: true }))).toBe("Submitted by the AI · waiting for you");
    expect(specDocumentStatus(ph({ status: "approved" }))).toBe("Approved");
  });
});
