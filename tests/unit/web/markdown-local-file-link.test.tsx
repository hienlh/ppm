import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import { markdownUrlTransform } from "../../../src/web/components/shared/markdown-context.ts";

describe("Markdown local file links", () => {
  it("preserves an absolute Windows file path for the editor link handler", () => {
    const html = renderToStaticMarkup(
      <ReactMarkdown urlTransform={markdownUrlTransform}>
        {"[Báo cáo và timeline](D:/Projects/nxsys/plans/NX-5886/diagnosis.md)"}
      </ReactMarkdown>,
    );

    expect(html).toContain('href="D:/Projects/nxsys/plans/NX-5886/diagnosis.md"');
  });

  it("continues to strip unsafe URL schemes", () => {
    const html = renderToStaticMarkup(
      <ReactMarkdown urlTransform={markdownUrlTransform}>{"[x](javascript:alert(1))"}</ReactMarkdown>,
    );

    expect(html).toContain('href=""');
  });
});
