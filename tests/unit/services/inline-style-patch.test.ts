import { describe, expect, it } from "bun:test";
import {
  escapeAttr, mergeStyle, parseStyleDeclarations, patchStartTagStyle,
} from "../../../src/services/design/source/inline-style-patch.ts";

const idOf = (text: string, needle: string) => {
  const at = text.indexOf(needle);
  if (at < 0) throw new Error(`no ${needle}`);
  return at;
};

/** Asserts that `after` is `before` with exactly `span` replaced, and nothing else. */
function onlySpanChanged(before: string, after: string, span: { start: number; oldText: string; newText: string }) {
  expect(before.slice(0, span.start)).toBe(after.slice(0, span.start));
  expect(before.slice(span.start, span.start + span.oldText.length)).toBe(span.oldText);
  expect(after.slice(span.start, span.start + span.newText.length)).toBe(span.newText);
  expect(before.slice(span.start + span.oldText.length)).toBe(after.slice(span.start + span.newText.length));
}

describe("parseStyleDeclarations", () => {
  it("splits on top-level semicolons only, entity-aware", () => {
    const raw = "font-family: &quot;A;B&quot;, serif; background: url(data:image/png;base64,xx); /* a;b */ COLOR: red !important";
    expect(parseStyleDeclarations(raw).map((d) => [d.name, d.important])).toEqual([
      ["font-family", false], ["background", false], ["color", true],
    ]);
  });

  it("reports raw spans that start at the name and end before the separator", () => {
    const raw = "  color : red ;width:1px";
    const [a, b] = parseStyleDeclarations(raw);
    expect(raw.slice(a!.start, a!.end)).toBe("color : red");
    expect(raw.slice(b!.start, b!.end)).toBe("width:1px");
  });
});

describe("mergeStyle", () => {
  it("rewrites the last declaration in place, keeps !important, drops earlier duplicates", () => {
    expect(mergeStyle("width: 1px; color: red; WIDTH: 2px !important", { width: "5px" })).toBe("color: red; width: 5px !important");
  });

  it("appends a missing property after the existing text", () => {
    expect(mergeStyle("color: red", { translate: "1px 2px" })).toBe("color: red; translate: 1px 2px");
    expect(mergeStyle("color: red;", { width: "3px" })).toBe("color: red; width: 3px");
    expect(mergeStyle("", { width: "3px", height: "4px" })).toBe("width: 3px; height: 4px");
    expect(mergeStyle("color:red; ", { width: "3px" })).toBe("color:red; width: 3px ");
  });

  it("keeps every untouched byte, entities included", () => {
    const raw = "font-family:&quot;Inter&quot;;  color :  #fff ;translate: 1px 1px";
    expect(mergeStyle(raw, { translate: "9px 9px" })).toBe("font-family:&quot;Inter&quot;;  color :  #fff ;translate: 9px 9px");
  });
});

describe("escapeAttr", () => {
  it("escapes what could end or break an attribute", () => {
    expect(escapeAttr(`a"b'c<d>&e`)).toBe("a&quot;b&#39;c&lt;d&gt;&amp;e");
  });
});

describe("patchStartTagStyle", () => {
  it("inserts a style attribute right after the tag name", () => {
    const text = '<!doctype html><body><div class="card">x</div></body>';
    const out = patchStartTagStyle(text, idOf(text, "<div"), "div", { translate: "10px 20px" });
    if ("error" in out) throw new Error(out.message);
    expect(out.text).toBe('<!doctype html><body><div style="translate: 10px 20px" class="card">x</div></body>');
    onlySpanChanged(text, out.text, out.span);
    expect(out.span.oldText).toBe("");
  });

  it("changes only the style attribute's span, keeping name spelling, quotes and other declarations", () => {
    const text = `<body>\r\n<section id=a STYLE='font-family:"Inter"; color: red; width: 10px' data-x=1>\r\n<p>y</p></section></body>`;
    const out = patchStartTagStyle(text, idOf(text, "<section"), "section", { width: "320px", height: "40.5px" });
    if ("error" in out) throw new Error(out.message);
    expect(out.span.newText).toBe(`STYLE='font-family:"Inter"; color: red; width: 320px; height: 40.5px'`);
    onlySpanChanged(text, out.text, out.span);
    expect(out.text).toContain("\r\n<p>y</p>");
  });

  it("round-trips entities in a double-quoted value", () => {
    const text = '<p style="font-family: &quot;A&quot;; translate: 1px 1px">t</p>';
    const out = patchStartTagStyle(text, 0, "p", { translate: "4px 5px" });
    if ("error" in out) throw new Error(out.message);
    expect(out.text).toBe('<p style="font-family: &quot;A&quot;; translate: 4px 5px">t</p>');
  });

  it("quotes an unquoted value and fills a bare attribute", () => {
    const unquoted = "<p style=color:red>t</p>";
    const a = patchStartTagStyle(unquoted, 0, "p", { width: "3px" });
    if ("error" in a) throw new Error(a.message);
    expect(a.text).toBe('<p style="color:red; width: 3px">t</p>');
    const bare = "<p style>t</p>";
    const b = patchStartTagStyle(bare, 0, "p", { width: "3px" });
    if ("error" in b) throw new Error(b.message);
    expect(b.text).toBe('<p style="width: 3px">t</p>');
  });

  it("patches a self-closing svg element", () => {
    const text = '<svg viewBox="0 0 10 10"><rect/></svg>';
    const out = patchStartTagStyle(text, idOf(text, "<rect"), "rect", { width: "8px" });
    if ("error" in out) throw new Error(out.message);
    expect(out.text).toBe('<svg viewBox="0 0 10 10"><rect style="width: 8px"/></svg>');
  });

  it("uses the first of two duplicate style attributes, the one the browser keeps", () => {
    const text = '<div style="color: red" style="color: blue">x</div>';
    const out = patchStartTagStyle(text, 0, "div", { width: "1px" });
    if ("error" in out) throw new Error(out.message);
    expect(out.text).toBe('<div style="color: red; width: 1px" style="color: blue">x</div>');
  });

  it("refuses a wrong offset or tag as element-moved", () => {
    const text = "<main><p>x</p></main>";
    expect(patchStartTagStyle(text, 1, "main", { width: "1px" })).toMatchObject({ error: "element-moved" });
    expect(patchStartTagStyle(text, idOf(text, "<p"), "div", { width: "1px" })).toMatchObject({ error: "element-moved" });
    expect(patchStartTagStyle(text, 999, "p", { width: "1px" })).toMatchObject({ error: "element-moved" });
    expect(patchStartTagStyle(text, idOf(text, "</p"), "p", { width: "1px" })).toMatchObject({ error: "element-moved" });
  });

  it("addresses BOM-less text: offsets past a stripped BOM line up", () => {
    const withBom = "\uFEFF<p>x</p>";
    const text = withBom.slice(1);
    const out = patchStartTagStyle(text, 0, "p", { height: "2px" });
    if ("error" in out) throw new Error(out.message);
    expect(out.text).toBe('<p style="height: 2px">x</p>');
  });
});
