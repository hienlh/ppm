import { describe, test, expect } from "bun:test";
import { parseSnippet } from "../../../src/web/components/chat/search-snippet";

describe("parseSnippet", () => {
  test("splits <mark> delimiters into marked/unmarked segments", () => {
    const parts = parseSnippet("configure the <mark>webhook</mark> endpoint");
    expect(parts).toEqual([
      { text: "configure the ", mark: false },
      { text: "webhook", mark: true },
      { text: " endpoint", mark: false },
    ]);
  });

  test("plain text with no marks is a single unmarked segment", () => {
    expect(parseSnippet("no marks here")).toEqual([{ text: "no marks here", mark: false }]);
  });

  test("multiple marks", () => {
    const parts = parseSnippet("<mark>a</mark> b <mark>c</mark>");
    expect(parts.filter((p) => p.mark).map((p) => p.text)).toEqual(["a", "c"]);
  });

  test("does NOT treat embedded HTML as markup (XSS-safe: only <mark> is special)", () => {
    // A <script> in message content must survive as literal text — it becomes
    // a React text node (escaped) downstream, never injected HTML.
    const parts = parseSnippet('<mark>hit</mark> <script>alert(1)</script>');
    const marked = parts.filter((p) => p.mark).map((p) => p.text);
    const plain = parts.filter((p) => !p.mark).map((p) => p.text).join("");
    expect(marked).toEqual(["hit"]);
    expect(plain).toContain("<script>alert(1)</script>");
  });
});
