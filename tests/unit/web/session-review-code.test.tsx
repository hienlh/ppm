/**
 * The Review tab's code rows: which grammar a file asks for, and how a line's syntax tokens and
 * the part of it that changed are laid over each other.
 */
import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ThemedToken } from "shiki";
import { CodeLine, reviewLanguage } from "../../../src/web/components/session-review/review-tokens.tsx";

const token = (content: string, color: string): ThemedToken => ({ content, color, offset: 0 }) as ThemedToken;

describe("reviewLanguage", () => {
  it("asks for the extension, which shiki takes as an alias, and names the files that have none", () => {
    expect(reviewLanguage("/p/src/app.tsx")).toBe("tsx");
    expect(reviewLanguage("C:\\p\\Main.CS")).toBe("cs");
    expect(reviewLanguage("/p/Dockerfile")).toBe("docker");
    expect(reviewLanguage("/p/Makefile")).toBe("make");
    expect(reviewLanguage("/p/.env")).toBeUndefined();
    expect(reviewLanguage("/p/LICENSE")).toBeUndefined();
  });
});

describe("CodeLine", () => {
  const tokens = [token("const ", "#00f"), token("limit", "#111"), token(" = max(5);", "#222")];

  it("marks the changed span across token boundaries, keeping each token's colour", () => {
    const html = renderToStaticMarkup(<CodeLine text="const limit = max(5);" tokens={tokens} span={[8, 14]} spanClass="mark" />);
    expect(html).toBe(
      '<span style="color:#00f">const </span><span style="color:#111">li</span>'
      + '<span style="color:#111" class="mark">mit</span><span style="color:#222" class="mark"> = </span>'
      + '<span style="color:#222">max(5);</span>',
    );
  });

  it("draws the line plain when its tokens belong to other text", () => {
    const html = renderToStaticMarkup(<CodeLine text="let x = 1;" tokens={tokens} span={null} spanClass="mark" />);
    expect(html).toBe("<span>let x = 1;</span>");
  });
});
