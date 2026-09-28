import { describe, expect, it } from "bun:test";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import {
  analyzeHtml, elementStartOffsets, headInsertOffset, injectWithoutParsing, instrumentHtml, isLocalHref,
  localStylesheetHrefs, tagNameEnd,
} from "../../../src/services/design/preview/html-instrument.ts";
import { decodeDesignText } from "../../../src/services/design/source/design-source-file.ts";

type Element = DefaultTreeAdapterMap["element"];
const BRIDGE = "<script data-ppm-bridge=\"1\">/*bridge*/</script>";

/** Every element of a parsed document, template content included, in document order. */
function elements(html: string): Element[] {
  const out: Element[] = [];
  const walk = (node: DefaultTreeAdapterMap["node"]): void => {
    if ("tagName" in node) out.push(node);
    const children = "tagName" in node && node.tagName === "template"
      ? (node as DefaultTreeAdapterMap["template"]).content.childNodes
      : "childNodes" in node ? node.childNodes : [];
    for (const child of children) walk(child);
  };
  walk(parse(html));
  return out;
}

/** Instrument, re-parse the output, and check every id points at its own tag in `source`. */
function assertIdsIndexSource(source: string): Element[] {
  const out = instrumentHtml(source, BRIDGE);
  const tagged = elements(out).filter((el) => el.attrs.some((a) => a.name === "data-ppm-id"));
  for (const el of tagged) {
    // First attribute, so a stale copy in the source can never win.
    expect(el.attrs[0]!.name).toBe("data-ppm-id");
    const id = Number(el.attrs[0]!.value);
    expect(source.slice(id, id + 1 + el.tagName.length).toLowerCase()).toBe(`<${el.tagName.toLowerCase()}`);
  }
  return tagged;
}

const FIXTURES: Record<string, string> = {
  crlf: "<!DOCTYPE html>\r\n<html lang=\"en\">\r\n<head>\r\n<title>CRLF</title>\r\n</head>\r\n<body>\r\n<main>\r\n<h1>Hi</h1>\r\n<p>One\r\ntwo</p>\r\n</main>\r\n</body>\r\n</html>\r\n",
  astral: "<!doctype html><html><head></head><body><p>😀 emoji 𝒳 math</p><span>🎉</span><p id=\"after\">after astral</p></body></html>",
  uppercase: "<!DOCTYPE HTML><HTML><HEAD><TITLE>Up</TITLE></HEAD><BODY CLASS=\"x\"><DIV><P>Loud</P><IMG SRC=\"a.png\"></DIV></BODY></HTML>",
  svg: "<!doctype html><body><svg viewBox=\"0 0 10 10\"><foreignObject width=\"5\"><div>in svg</div></foreignObject><circle r=\"1\"/></svg><br/><input disabled></body>",
  template: "<!doctype html><body><template><section><b>inert</b></section></template><p>live</p></body>",
  implicit: "<p>no html, head or body tags<table><tr><td>cell</td></tr></table>",
  rawText: "<!doctype html><head><script>var s = '<p id=fake>';</script><style>p::before{content:'<div>'}</style></head><body><textarea><b>text</b></textarea><!-- <p>comment</p> --><p>real</p></body>",
};

describe("element start offsets", () => {
  for (const [name, source] of Object.entries(FIXTURES)) {
    it(`every id indexes its own start tag (${name})`, () => {
      const tagged = assertIdsIndexSource(source);
      expect(tagged.length).toBe(elementStartOffsets(source).length);
    });
  }

  it("indexes the BOM-less text, where a BOM would have cost html/head/body their ids", () => {
    const raw = "﻿<!doctype html>\r\n<html><head><title>b</title></head><body><p>x</p></body></html>";
    const { text, bom } = decodeDesignText(new TextEncoder().encode(raw));
    expect(bom).toBe(true);
    const tags = assertIdsIndexSource(text).map((el) => el.tagName);
    expect(tags).toEqual(["html", "head", "title", "body", "p"]);
  });

  it("gives parser-invented elements no id and adoption-agency clones their original's", () => {
    const implicit = assertIdsIndexSource(FIXTURES.implicit!).map((el) => el.tagName);
    expect(implicit).not.toContain("html");
    expect(implicit).not.toContain("tbody");
    const misnested = "<b><i>x</b>y</i>";
    const ids = elements(instrumentHtml(misnested, BRIDGE))
      .filter((el) => el.tagName === "i").map((el) => el.attrs.find((a) => a.name === "data-ppm-id")?.value);
    expect(ids).toEqual(["3", "3"]);
  });

  it("ignores markup inside raw-text elements and comments", () => {
    const tags = assertIdsIndexSource(FIXTURES.rawText!).map((el) => el.tagName);
    expect(tags.filter((t) => t === "p")).toHaveLength(1);
    expect(tags).not.toContain("div");
  });

  it("overrides a stale data-ppm-id already written into the file", () => {
    const source = "<body><p data-ppm-id=\"999\" class=\"a\">x</p></body>";
    const [, p] = assertIdsIndexSource(source);
    expect(p!.attrs.filter((a) => a.name === "data-ppm-id").map((a) => a.value)).toEqual([String(source.indexOf("<p"))]);
  });

  it("stops the tag name where the tokenizer does", () => {
    expect(tagNameEnd("<br/>", 0)).toBe(3);
    expect(tagNameEnd("<p\r\nclass=a>", 0)).toBe(2);
    expect(tagNameEnd("<my-el>", 0)).toBe(6);
  });

  it("only inserts, never rewrites the rest of the source", () => {
    const source = FIXTURES.crlf!;
    const out = instrumentHtml(source, BRIDGE);
    expect(out.replace(/ data-ppm-id="\d+"/g, "").replace(BRIDGE, "")).toBe(source);
  });
});

describe("bridge placement", () => {
  const firstScript = (html: string): Element | undefined => elements(html).find((el) => el.tagName === "script");

  it("goes right after an explicit <head> start tag, ahead of the page's scripts", () => {
    const source = "<!doctype html><html><head data-x=\"1\"><meta charset=\"utf-8\"><script>page()</script></head><body></body></html>";
    const out = instrumentHtml(source, BRIDGE);
    expect(headInsertOffset(source)).toBe(source.indexOf("<meta"));
    expect(firstScript(out)!.attrs.some((a) => a.name === "data-ppm-bridge")).toBe(true);
  });

  it("falls back to after <html>, then after the doctype, then the start", () => {
    expect(headInsertOffset("<html lang=en><body>x")).toBe("<html lang=en>".length);
    expect(headInsertOffset("<!doctype html><title>t</title>")).toBe("<!doctype html>".length);
    expect(headInsertOffset("<p>bare</p>")).toBe(0);
    for (const source of ["<html lang=en><body>x", "<!doctype html><title>t</title><script>page()</script>", "<p>bare</p>"]) {
      expect(firstScript(instrumentHtml(source, BRIDGE))!.attrs.some((a) => a.name === "data-ppm-bridge")).toBe(true);
    }
  });

  it("keeps the doctype first without parsing when the file is too large to instrument", () => {
    expect(injectWithoutParsing("  <!DOCTYPE html><p>x", BRIDGE)).toBe(`  <!DOCTYPE html>${BRIDGE}<p>x`);
    expect(injectWithoutParsing("<p>x", BRIDGE)).toBe(`${BRIDGE}<p>x`);
  });
});

describe("local stylesheets", () => {
  it("lists relative stylesheet links in document order and nothing else", () => {
    const source = `<!doctype html><head>
      <link rel="stylesheet" href="styles.css">
      <link rel="Stylesheet preload" href="./theme/a.css?v=2">
      <link rel="stylesheet" href="../tokens.css">
      <link rel="stylesheet" href="https://cdn.jsdelivr.net/x.css">
      <link rel="stylesheet" href="//cdn.example/y.css">
      <link rel="stylesheet" href="/root.css">
      <link rel="icon" href="favicon.png">
      <link rel="stylesheet">
      </head><body><template><link rel="stylesheet" href="inert.css"></template></body>`;
    expect(localStylesheetHrefs(source)).toEqual(["styles.css", "./theme/a.css?v=2", "../tokens.css"]);
  });

  it("classifies hrefs", () => {
    for (const href of ["a.css", "./a.css", "../tokens.css", "dir/a b.css"]) expect(isLocalHref(href)).toBe(true);
    for (const href of ["", "  ", "https://x/a.css", "data:text/css,a", "//x/a.css", "/a.css", "#x", "JavaScript:x"]) {
      expect(isLocalHref(href)).toBe(false);
    }
  });
});

describe("a 1 MB document", () => {
  it("instruments every element correctly and without a quadratic blow-up", () => {
    const section = "<section class=\"card\">\r\n  <h2>Title 😀</h2>\r\n  <p>Some <b>bold</b> and <i>italic</i> text.</p>\r\n  <img src=\"a.png\" alt=\"\">\r\n</section>\r\n";
    const source = `<!doctype html><html><head><title>big</title></head><body>${section.repeat(Math.ceil(1_048_576 / section.length))}</body></html>`;
    expect(source.length).toBeGreaterThan(1_000_000);
    const started = performance.now();
    const analysis = analyzeHtml(source);
    const out = instrumentHtml(source, BRIDGE, analysis);
    const elapsed = performance.now() - started;
    // Generous: this guards against pathological growth, not the host's speed.
    expect(elapsed).toBeLessThan(5000);
    const ids = [...out.matchAll(/ data-ppm-id="(\d+)"/g)].map((m) => Number(m[1]));
    expect(ids).toEqual(analysis.elementOffsets);
    for (const id of ids) expect(source.charCodeAt(id)).toBe(60);
  });
});
