import { describe, expect, it } from "bun:test";
import { planTweakPatches, type PlannedTweak } from "../../../src/services/design/source/tweak-patch-plan.ts";
import { htmlStyleNodes } from "../../../src/services/design/source/html-style-blocks.ts";
import type { StyleSource } from "../../../src/services/design/source/design-style-sources.ts";
import { parseTweaks, type TweakDef } from "../../../src/shared/design-tweaks.ts";

/**
 * Which declaration a tweak lands in, over an in-memory page: the entry HTML's `<style>`
 * blocks plus linked files, in document order — the same sources `styleSources` reads.
 */

const tweak = (over: Record<string, unknown> = {}): TweakDef =>
  parseTweaks([{ id: "a", label: "Accent", type: "color", var: "--accent", default: "#000000", ...over }]).tweaks[0]!;
const set = (value: string, over: Record<string, unknown> = {}): PlannedTweak => ({ def: tweak(over), value });

function page(html: string, linked: Record<string, string> = {}, outside: string[] = []) {
  const texts = new Map<string, string>([["index.html", html], ...Object.entries(linked)]);
  const sources: StyleSource[] = htmlStyleNodes(html).map((n) => n.kind === "inline"
    ? { file: "index.html", kind: "inline", start: n.start, end: n.end, conditional: n.conditional, outside: false }
    : {
      file: n.href, kind: "linked", start: 0, end: linked[n.href]!.length, conditional: n.conditional, outside: outside.includes(n.href),
    });
  return { texts, sources, plan: (t: PlannedTweak[]) => planTweakPatches("index.html", sources, texts, t) };
}

describe("planTweakPatches", () => {
  it("patches the later of two :root rules, which is the one that wins", () => {
    const html = "<style>:root{--accent:#111111}</style><style>:root{--accent:#222222}</style>";
    expect(page(html).plan([set("#abcdef")]).get("index.html"))
      .toBe("<style>:root{--accent:#111111}</style><style>:root{--accent:#abcdef}</style>");
  });

  it("patches a later linked file over an earlier inline block", () => {
    const html = '<style>:root{--accent:#111111}</style><link rel="stylesheet" href="theme.css">';
    const out = page(html, { "theme.css": ":root { --accent: #222222; }\n" }).plan([set("#abcdef")]);
    expect([...out.keys()]).toEqual(["theme.css"]);
    expect(out.get("theme.css")).toBe(":root { --accent: #abcdef; }\n");
  });

  it("appends a missing variable at the end of the last source, never before existing rules", () => {
    const html = '<link rel="stylesheet" href="a.css"><style>\n  body { margin: 0 }\n</style>';
    const out = page(html, { "a.css": ":root { --radius: 4px }\n" }).plan([set("#abcdef")]);
    expect(out.get("index.html")).toBe('<link rel="stylesheet" href="a.css"><style>\n  body { margin: 0 }\n\n:root {\n  --accent: #abcdef;\n}\n</style>');
    expect(out.has("a.css")).toBe(false);
  });

  it("appends to the tweak's file when it is one of the page's sources", () => {
    const html = '<link rel="stylesheet" href="a.css"><link rel="stylesheet" href="b.css">';
    const out = page(html, { "a.css": "a{}\n", "b.css": "b{}\n" }).plan([set("#abcdef", { file: "a.css" })]);
    expect(out.get("a.css")).toBe("a{}\n\n:root {\n  --accent: #abcdef;\n}\n");
    const ignored = page(html, { "a.css": "a{}\n", "b.css": "b{}\n" }).plan([set("#abcdef", { file: "other.css" })]);
    expect([...ignored.keys()]).toEqual(["b.css"]);
  });

  it("appends after a shared-selector rule instead of rewriting it", () => {
    const html = "<style>:root, .dark { --accent: #111111 }</style>";
    expect(page(html).plan([set("#abcdef")]).get("index.html"))
      .toBe("<style>:root, .dark { --accent: #111111 }\n\n:root {\n  --accent: #abcdef;\n}\n</style>");
  });

  it("adds a <style> at the end of <head> when the page has no stylesheet of its own", () => {
    const html = "<!doctype html><html><head><title>x</title></head><body></body></html>";
    expect(page(html).plan([set("#abcdef")]).get("index.html"))
      .toBe("<!doctype html><html><head><title>x</title><style>\n:root {\n  --accent: #abcdef;\n}\n</style>\n</head><body></body></html>");
  });

  it("refuses when the winner is inside @media, in a media-limited sheet, outside the design or !important", () => {
    expect(() => page("<style>:root{--accent:#111}@media (min-width: 1px){:root{--accent:#222}}</style>").plan([set("#abcdef")]))
      .toThrow(/inside an @media block/);
    expect(() => page('<style>:root{--accent:#111}</style><style media="print">:root{--accent:#222}</style>').plan([set("#abcdef")]))
      .toThrow(/media attribute/);
    const tokens = page('<style>:root{--accent:#111}</style><link rel="stylesheet" href="../tokens.css">', { "../tokens.css": ":root{--accent:#999}" }, ["../tokens.css"]);
    expect(() => tokens.plan([set("#abcdef")])).toThrow(/every design in the project shares/);
    expect(() => page("<style>:root{--accent:#111 !important}</style>").plan([set("#abcdef")])).toThrow(/!important/);
  });

  it("patches an unconditional declaration that comes after a conditional one, and ignores tokens.css that does not set it", () => {
    const html = '<link rel="stylesheet" href="../tokens.css"><style>@media print{:root{--accent:#222}}:root{--accent:#333}</style>';
    const out = page(html, { "../tokens.css": ":root{--gap:1px}" }, ["../tokens.css"]).plan([set("#abcdef")]);
    expect(out.get("index.html")).toBe('<link rel="stylesheet" href="../tokens.css"><style>@media print{:root{--accent:#222}}:root{--accent:#abcdef}</style>');
  });

  it("refuses to append to a source that does not end cleanly", () => {
    expect(() => page("<style>:root, a { --accent: #1 } /* open</style>").plan([set("#abcdef")])).toThrow(/does not end cleanly/);
  });

  it("combines in-place edits and an append in one region and leaves every other byte alone", () => {
    const css = "/* keep */\n:root {\n  --accent: #111111;\n}\n.x { color: var(--accent) }\n";
    const radius = parseTweaks([{ id: "r", label: "R", type: "range", var: "--radius", min: 0, max: 9, step: 1, unit: "px", default: 1 }]).tweaks[0]!;
    const out = page('<link rel="stylesheet" href="s.css">', { "s.css": css }).plan([set("#abcdef"), { def: radius, value: "3px" }]);
    expect(out.get("s.css")).toBe("/* keep */\n:root {\n  --accent: #abcdef;\n}\n.x { color: var(--accent) }\n\n:root {\n  --radius: 3px;\n}\n");
  });

  it("returns nothing when every value is already in place", () => {
    expect(page("<style>:root{--accent:#abcdef}</style>").plan([set("#abcdef")]).size).toBe(0);
  });
});
