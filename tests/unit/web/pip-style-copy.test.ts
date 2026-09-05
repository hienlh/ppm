import { describe, it, expect } from "bun:test";
import {
  collectStyleNodes,
  syncThemeToPip,
  type StyleNodeSource,
} from "../../../src/web/components/floating-window/pip/pip-style-copy.ts";

/** Minimal document shape for the theme mirror (no defaultView → no subscription). */
function themeDoc(html: { className: string; cssText: string }, body: { className: string; cssText: string }) {
  return {
    documentElement: { className: html.className, style: { cssText: html.cssText } },
    body: { className: body.className, style: { cssText: body.cssText } },
    defaultView: null,
  } as unknown as Document;
}

/** Fake document that records the selector and answers with fixed nodes. */
function fakeDoc(nodes: unknown[]): StyleNodeSource & { selectors: string[] } {
  const selectors: string[] = [];
  return {
    selectors,
    querySelectorAll(selector: string) {
      selectors.push(selector);
      return nodes as never;
    },
  };
}

describe("collectStyleNodes", () => {
  it("asks for both <style> and <link rel=stylesheet>", () => {
    const doc = fakeDoc([]);
    collectStyleNodes(doc);
    expect(doc.selectors).toHaveLength(1);
    expect(doc.selectors[0]).toBe('style, link[rel="stylesheet"]');
  });

  it("returns an empty array for a document with no styles", () => {
    expect(collectStyleNodes(fakeDoc([]))).toEqual([]);
  });

  it("preserves document order — cascade depends on it", () => {
    const a = { id: "a" };
    const b = { id: "b" };
    const c = { id: "c" };
    expect(collectStyleNodes(fakeDoc([a, b, c]))).toEqual([a, b, c] as never);
  });

  it("copies the live node list into a plain array", () => {
    const nodes = [{ id: "a" }];
    const result = collectStyleNodes(fakeDoc(nodes));
    expect(Array.isArray(result)).toBe(true);
    nodes.push({ id: "b" });
    expect(result).toHaveLength(1);
  });
});

describe("syncThemeToPip", () => {
  it("mirrors html class + vars and body class + inline background", () => {
    const src = themeDoc(
      { className: "dark", cssText: "--bg: #0b0f14; --text: #fff;" },
      { className: "text-text font-sans", cssText: "background: var(--bg);" },
    );
    const dst = themeDoc({ className: "", cssText: "" }, { className: "", cssText: "" });
    syncThemeToPip(src, dst);
    expect(dst.documentElement.className).toBe("dark");
    expect(dst.documentElement.style.cssText).toBe("--bg: #0b0f14; --text: #fff;");
    expect(dst.body.className).toBe("text-text font-sans");
    // The page background lives in body's inline style, not a class — a PiP body
    // without it stays browser-default white behind any transparent tab region.
    expect(dst.body.style.cssText).toBe("background: var(--bg);");
  });
});
