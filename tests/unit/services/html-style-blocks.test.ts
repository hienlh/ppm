import { describe, expect, it } from "bun:test";
import { findStyleBlocks, headEndOffset, htmlStyleNodes } from "../../../src/services/design/source/html-style-blocks.ts";
import { linkedStylePath } from "../../../src/services/design/source/design-style-sources.ts";

const texts = (html: string) => findStyleBlocks(html).map((b) => html.slice(b.start, b.end));

describe("findStyleBlocks", () => {
  it("returns every applied <style>'s text in document order, including one in <body>", () => {
    const html = "<html><head><style>a{}</style><style type=\"text/css\">b{}</style></head><body><p>x</p><style>\n c{} \n</style></body></html>";
    expect(texts(html)).toEqual(["a{}", "b{}", "\n c{} \n"]);
  });

  it("finds nothing in a page without styles", () => {
    expect(findStyleBlocks("<!doctype html><p>hello</p>")).toEqual([]);
  });

  it("skips <template> contents and non-CSS style types", () => {
    const html = "<template><style>x{}</style></template><style type=\"text/less\">y{}</style><style>z{}</style>";
    expect(texts(html)).toEqual(["z{}"]);
  });

  it("uses offsets into the exact text, CRLF and astral characters included", () => {
    const html = "<!doctype html>\r\n<html>\r\n<head>\r\n<title>😀</title>\r\n<style>\r\n:root { --x: 1px }\r\n</style>\r\n</head></html>";
    expect(texts(html)).toEqual(["\r\n:root { --x: 1px }\r\n"]);
  });

  it("ends an unclosed style at the end of the text", () => {
    expect(texts("<style>a{}")).toEqual(["a{}"]);
  });
});

describe("htmlStyleNodes", () => {
  it("interleaves inline blocks and local links in document order and marks media-limited ones", () => {
    const html = '<link rel="stylesheet" href="a.css"><style>x{}</style><link rel="stylesheet" media="print" href="p.css">'
      + '<link rel="stylesheet" href="https://cdn.jsdelivr.net/x.css"><link rel="alternate stylesheet" href="alt.css">'
      + '<link rel="stylesheet" href="off.css" disabled><link rel="icon" href="i.png"><style media="all">y{}</style>';
    expect(htmlStyleNodes(html).map((n) => (n.kind === "linked" ? [n.href, n.conditional] : ["inline", n.conditional]))).toEqual([
      ["a.css", false], ["inline", false], ["p.css", true], ["inline", false],
    ]);
  });
});

describe("headEndOffset", () => {
  it("points before </head>, after an unclosed <head>, before <body>, or after the doctype", () => {
    const withHead = "<html><head><title>x</title></head><body></body></html>";
    expect(withHead.slice(headEndOffset(withHead))).toStartWith("</head>");
    const bodyOnly = "<!doctype html><body><p>x</p></body>";
    expect(bodyOnly.slice(headEndOffset(bodyOnly))).toStartWith("<body>");
    const bare = "<!DOCTYPE html>\n<p>x</p>";
    expect(headEndOffset(bare)).toBe("<!DOCTYPE html>".length);
  });
});

describe("linkedStylePath", () => {
  it("resolves hrefs against the entry, keeps the shared tokens.css and drops anything else outside", () => {
    expect(linkedStylePath("index.html", "styles.css?v=2")).toBe("styles.css");
    expect(linkedStylePath("pages/a.html", "../css/x.css")).toBe("css/x.css");
    expect(linkedStylePath("index.html", "../tokens.css")).toBe("../tokens.css");
    expect(linkedStylePath("pages/a.html", "../../tokens.css")).toBe("../tokens.css");
    expect(linkedStylePath("index.html", "../other/x.css")).toBeNull();
    expect(linkedStylePath("index.html", "theme.php")).toBeNull();
    expect(linkedStylePath("index.html", "%E0%A4%A.css")).toBeNull();
  });
});
