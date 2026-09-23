import { afterEach, describe, expect, it } from "bun:test";
import { Window } from "happy-dom";
import { diceSimilarity, resolveAnchor, type AnchorCandidate } from "../../../src/services/design/bridge/bridge-anchor-resolve.ts";
import { anchorOf } from "../../../src/services/design/bridge/bridge-element-info.ts";
import { BRIDGE_LIB } from "../../../src/services/design/bridge/bridge-script.ts";
import type { BridgeApi } from "../../../src/services/design/bridge/bridge-core.ts";
import { instrumentHtml } from "../../../src/services/design/preview/html-instrument.ts";
import { computeGen } from "../../../src/services/design/source/design-source-file.ts";
import { elementSourceRange } from "../../../src/services/design/source/element-source-range.ts";
import type { CommentAnchor } from "../../../src/shared/design-comment-types.ts";

/**
 * Anchors are built the way the canvas builds them: the source is instrumented exactly as
 * the preview route does, loaded into a DOM, and each element described by the same
 * `anchorOf` the bridge ships.
 */

const open: Window[] = [];
afterEach(async () => {
  for (const win of open.splice(0)) await win.happyDOM.close();
});

interface Loaded {
  gen: string;
  els: Element[];
  candidates: AnchorCandidate[];
}

function load(html: string): Loaded {
  const win = new Window();
  open.push(win);
  win.document.write(instrumentHtml(html, ""));
  const ppm = { lib: BRIDGE_LIB, doc: win.document } as unknown as BridgeApi;
  const els = Array.from(win.document.body.querySelectorAll("*")) as unknown as Element[];
  return { gen: computeGen(html), els, candidates: els.map((el) => anchorOf(el, ppm)) };
}

function anchorFor(page: Loaded, match: (el: Element) => boolean): CommentAnchor {
  const i = page.els.findIndex(match);
  expect(i).toBeGreaterThanOrEqual(0);
  return { file: "index.html", gen: page.gen, ...page.candidates[i]! };
}

const resolve = (a: CommentAnchor, page: Loaded) => resolveAnchor(a, page.candidates, page.gen, diceSimilarity);
const text = (el: Element | undefined) => el?.textContent?.trim();

describe("diceSimilarity", () => {
  it("is 1 for equal text, 0 for disjoint, and ignores case and spacing", () => {
    expect(diceSimilarity("Pricing  starts", "pricing starts")).toBe(1);
    expect(diceSimilarity("", "")).toBe(1);
    expect(diceSimilarity("abc", "xyz")).toBe(0);
    expect(diceSimilarity("a", "")).toBe(0);
    const s = diceSimilarity("Pricing starts at $9", "Pricing starts at $19");
    expect(s).toBeGreaterThan(0.8);
    expect(s).toBeLessThan(1);
  });
});

describe("resolveAnchor", () => {
  const v1 = "<main><p>A long introduction to the product</p><p>Pricing starts at $9 a month</p></main>";

  it("trusts the id while the gen is unchanged", () => {
    const page = load(v1);
    const anchor = anchorFor(page, (el) => text(el)?.startsWith("Pricing") === true);
    const r = resolve(anchor, page);
    expect(r.status).toBe("exact");
    expect(text(page.els[r.index])).toContain("Pricing");
  });

  it("does not trust an old id that now names a different element after an edit above it", () => {
    const before = load(v1);
    const anchor = anchorFor(before, (el) => text(el)?.startsWith("Pricing") === true);
    // Pad the text above so the *first* <p> lands exactly on the old id.
    const pad = "x".repeat(anchor.ppmId! - "<main>".length);
    const v2 = `<main>${pad}<p>A long introduction to the product</p><p>Pricing starts at $9 a month</p></main>`;
    const after = load(v2);
    const impostor = after.candidates.findIndex((c) => c.ppmId === anchor.ppmId);
    expect(text(after.els[impostor])).toContain("introduction");

    const r = resolve(anchor, after);
    expect(r.status).toBe("reanchored");
    expect(text(after.els[r.index])).toContain("Pricing");
    expect(after.candidates[r.index]!.ppmId).not.toBe(anchor.ppmId);
  });

  it("follows the element when the AI reorders its siblings", () => {
    const before = load("<ul><li>Alpha feature</li><li>Beta feature</li><li>Gamma feature</li></ul>");
    const anchor = anchorFor(before, (el) => text(el) === "Beta feature");
    const after = load("<ul><li>Gamma feature</li><li>Alpha feature</li><li>Beta feature</li></ul>");
    const r = resolve(anchor, after);
    expect(r.status).toBe("reanchored");
    expect(text(after.els[r.index])).toBe("Beta feature");
  });

  it("orphans a comment whose element was deleted rather than guessing", () => {
    const before = load(v1);
    const anchor = anchorFor(before, (el) => text(el)?.startsWith("Pricing") === true);
    const after = load("<main><p>A long introduction to the product</p><p>Contact us today</p></main>");
    expect(resolve(anchor, after).status).toBe("orphaned");
  });

  it("only considers elements of the same tag", () => {
    const before = load("<div><h2>Pricing starts at $9 a month</h2></div>");
    const anchor = anchorFor(before, (el) => el.localName === "h2");
    const after = load("<div><h3>Pricing starts at $9 a month</h3></div>");
    expect(resolve(anchor, after).status).toBe("orphaned");
  });

  it("breaks a tie between near-identical elements with the CSS path", () => {
    const quote = { exact: "Buy now", prefix: "Plan", suffix: "Details" };
    const candidates: AnchorCandidate[] = [
      { ppmId: 10, tag: "button", cssPath: "body > section:nth-of-type(1) > button:nth-of-type(1)", quote },
      { ppmId: 90, tag: "button", cssPath: "body > section:nth-of-type(2) > button:nth-of-type(1)", quote },
    ];
    const anchor: CommentAnchor = {
      file: "index.html", ppmId: 50, gen: "0000000000000000", tag: "button",
      cssPath: "body > section:nth-of-type(2) > button:nth-of-type(1)", quote,
    };
    const r = resolveAnchor(anchor, candidates, "1111111111111111", diceSimilarity);
    expect(r).toMatchObject({ status: "reanchored", index: 1 });
  });

  it("recognises an element with no text by what surrounds it, and never matches it to text", () => {
    const before = load("<div><p>Hero title</p><img src=a.png><p>Team photo caption</p><img src=b.png><p>Footer note</p></div>");
    const anchor = anchorFor(before, (el) => el.getAttribute("src") === "b.png");
    expect(anchor.quote.exact).toBe("");
    const after = load("<div><h1>New banner</h1><p>Hero title</p><img src=a.png><p>Team photo caption</p><img src=b.png><p>Footer note</p></div>");
    const r = resolve(anchor, after);
    expect(r.status).toBe("reanchored");
    expect(after.els[r.index]!.getAttribute("src")).toBe("b.png");

    const textOnly = resolveAnchor(anchor, [{ ppmId: 1, tag: "img", cssPath: "", quote: { ...anchor.quote, exact: "alt" } }], "1111111111111111", diceSimilarity);
    expect(textOnly.status).toBe("orphaned");
  });

  it("computes the same quote from the source as the canvas does from the DOM", () => {
    // The server re-validates a re-anchor with the parse5 side of `elementQuote`; if the two
    // disagreed, no re-anchor would ever be accepted.
    const html = "<!doctype html><html><head><title>T</title></head><body><header><h1>Brand</h1><nav><a href=#a>One</a> <a href=#b>Two</a></nav></header>"
      + "<main><section><h2>Plans</h2><p>Pick   the plan\nthat fits.<b>Now</b></p><script>var x = 1;</script><img src=x.png></section></main><footer>© 2026</footer></body></html>";
    const page = load(html);
    for (let i = 0; i < page.els.length; i++) {
      const c = page.candidates[i]!;
      if (c.ppmId === null) continue;
      expect(elementSourceRange(html, c.ppmId)?.quote).toEqual(c.quote);
    }
  });
});
