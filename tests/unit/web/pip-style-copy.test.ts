import { describe, it, expect } from "bun:test";
import {
  collectStyleNodes,
  type StyleNodeSource,
} from "../../../src/web/components/floating-window/pip/pip-style-copy.ts";

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
