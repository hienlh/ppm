import { describe, expect, it } from "bun:test";
import { withoutHtmlComments } from "../../../src/web/components/spec/spec-pane.tsx";

describe("withoutHtmlComments", () => {
  it("drops the templates' notes but keeps code blocks as written", () => {
    const md = "## Testing\n<!-- for the AI -->\nText\n```html\n<!-- kept -->\n```\nAfter <!-- inline --> end\n";
    expect(withoutHtmlComments(md)).toBe("## Testing\nText\n```html\n<!-- kept -->\n```\nAfter  end\n");
  });
});
