import { describe, expect, it } from "bun:test";
import { inlineCssUrls, resolveDesignRef, type InlineContext } from "../../../src/services/design/export/css-url-inline.ts";
import type { ReadAsset } from "../../../src/services/design/export/design-export-asset-reader.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const b64 = (s: string) => Buffer.from(s).toString("base64");

function memoryReader(files: Record<string, string>, refused: string[] = []): ReadAsset & { reads: string[] } {
  const reads: string[] = [];
  const read = (async (rel: string, max: number) => {
    reads.push(rel);
    if (refused.includes(rel)) return { ok: false, reason: "refused" } as const;
    const body = files[rel];
    if (body === undefined) return { ok: false, reason: "missing" } as const;
    if (body.length > max) return { ok: false, reason: "too-large" } as const;
    return { ok: true, bytes: enc(body) } as const;
  }) as ReadAsset & { reads: string[] };
  read.reads = reads;
  return read;
}

const ctxFor = (readAsset: ReadAsset, perAsset = 1000, total = 5000): InlineContext =>
  ({ readAsset, budget: { perAsset, remaining: total }, warnings: [] });

describe("resolveDesignRef", () => {
  it("resolves against the referring file's folder and keeps a fragment", () => {
    expect(resolveDesignRef("../img/a.png#x", "css")).toEqual({ rel: "img/a.png", suffix: "#x" });
    expect(resolveDesignRef("a%20b.png?v=2", "")).toEqual({ rel: "a b.png", suffix: "" });
    expect(resolveDesignRef("../tokens.css", ".")).toEqual({ rel: "../tokens.css", suffix: "" });
    expect(resolveDesignRef("../../tokens.css", "css")).toEqual({ rel: "../tokens.css", suffix: "" });
  });

  it("leaves non-local references alone and refuses the way out and dot-dirs", () => {
    for (const ref of ["https://cdn.jsdelivr.net/x.css", "data:image/png;base64,AA", "#frag", "/abs.png", "//cdn/x.png"]) {
      expect(resolveDesignRef(ref, "")).toBeNull();
    }
    for (const ref of ["../other/x.png", "../../x.png", ".design/x.png", "img/.hidden/x.png", "%zz.png", "a\\b.png"]) {
      expect(resolveDesignRef(ref, "")).toEqual({ outside: true });
    }
  });
});

describe("inlineCssUrls", () => {
  it("inlines url() relative to the stylesheet with the MIME type from the extension", async () => {
    const reader = memoryReader({ "img/hero.png": "PNG", "fonts/a.woff2": "WOFF" });
    const ctx = ctxFor(reader);
    const css = await inlineCssUrls(".h{background:url(../img/hero.png)} @font-face{src:url('../fonts/a.woff2') format('woff2')}", "css", ctx);
    expect(css).toContain(`url("data:image/png;base64,${b64("PNG")}")`);
    expect(css).toContain(`url("data:font/woff2;base64,${b64("WOFF")}") format('woff2')`);
    expect(ctx.warnings).toEqual([]);
    expect(ctx.budget.remaining).toBe(5000 - 7);
  });

  it("inlines a local @import as CSS whose own urls resolve against the imported file", async () => {
    const reader = memoryReader({ "css/base.css": ".a{background:url(dot.svg)}", "css/dot.svg": "<svg/>" });
    const css = await inlineCssUrls("@import \"css/base.css\"; .b{}", "", ctxFor(reader));
    const inner = /data:text\/css;base64,([A-Za-z0-9+/=]+)/.exec(css)![1]!;
    expect(Buffer.from(inner, "base64").toString()).toContain(`data:image/svg+xml;base64,${b64("<svg/>")}`);
    expect(css.endsWith("; .b{}")).toBe(true);
  });

  it("keeps CDN and data references untouched and reads nothing for them", async () => {
    const reader = memoryReader({});
    const src = "@import url(https://fonts.googleapis.com/css2?family=Inter); .a{background:url(data:image/png;base64,AA)}";
    expect(await inlineCssUrls(src, "", ctxFor(reader))).toBe(src);
    expect(reader.reads).toEqual([]);
  });

  it("keeps the link and warns for a missing, refused, oversized or over-budget asset, or one outside", async () => {
    const reader = memoryReader({ "big.png": "x".repeat(50), "a.png": "aaaa", "b.png": "bbbb" }, ["locked.png"]);
    const ctx = ctxFor(reader, 20, 6);
    const src = ".a{x:url(gone.png)}.b{x:url(locked.png)}.c{x:url(big.png)}.d{x:url(a.png)}.e{x:url(b.png)}.f{x:url(../../x.png)}";
    const css = await inlineCssUrls(src, "", ctx);
    expect(css).toContain("url(gone.png)");
    expect(css).toContain("url(locked.png)");
    expect(css).toContain("url(big.png)");
    expect(css).toContain(`url("data:image/png;base64,${b64("aaaa")}")`);
    expect(css).toContain("url(b.png)");
    expect(ctx.warnings).toHaveLength(5);
    expect(ctx.warnings.join("\n")).toMatch(/gone\.png: not found[\s\S]*locked\.png: not readable[\s\S]*big\.png: larger than[\s\S]*b\.png: the export's size limit[\s\S]*outside the design/);
  });

  it("stops following @import cycles", async () => {
    const reader = memoryReader({ "a.css": "@import 'b.css';", "b.css": "@import 'a.css';" });
    const ctx = ctxFor(reader, 1000, 100_000);
    await inlineCssUrls("@import 'a.css';", "", ctx);
    expect(ctx.warnings.some((w) => w.includes("nested too deeply"))).toBe(true);
  });
});
