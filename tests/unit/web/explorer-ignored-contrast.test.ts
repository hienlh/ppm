/**
 * A gitignored row was dimmed with `opacity`, and an alpha blend is not
 * symmetric between light and dark.
 *
 * `opacity-40` on the row reads as one number for both modes, and it is not:
 * fading a near-white name on a near-black panel keeps a usable gap, while
 * fading a near-black name on a white one collapses it — measured below, 40%
 * put a gitignored *file* name at 1.7:1 on the light themes. That is not "low
 * contrast", it is a name that cannot be read, which is how a whole `.claude/`
 * subtree looked blank on a light theme while being perfectly legible on a dark
 * one. The same fade also washed out the icon, which is full-colour artwork
 * with no `currentColor` to carry the state.
 *
 * So the state is a *colour* — `--color-text-dim`, halfway between `--text-2`
 * and `--text-3` — and the icon is left alone. This test measures both the
 * hazard and the mitigation against PPM's own themes, because the mitigation is
 * one `color-mix` in a stylesheet and nothing about it says what it is for.
 */
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BUILTIN_THEMES } from "../../../src/web/theme/builtin/index.ts";

const read = (p: string) => readFileSync(resolve(import.meta.dir, "../../../src/web/", p), "utf8");
const treeNode = read("components/explorer/tree-node.tsx");
const globals = read("styles/globals.css");

/** Relative luminance, per WCAG. */
function luminance([r, g, b]: number[]): number {
  const channel = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r!) + 0.7152 * channel(g!) + 0.0722 * channel(b!);
}

function contrast(a: number[], b: number[]): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

function rgb(hex: string): number[] {
  const n = parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** `color-mix(in srgb, a P%, b)` and `opacity` over a backdrop are the same maths. */
function mix(a: number[], b: number[], portionOfA: number): number[] {
  return a.map((c, i) => c * portionOfA + b[i]! * (1 - portionOfA));
}

const themes = Object.entries(BUILTIN_THEMES).map(([id, t]) => ({
  id,
  mode: t.mode,
  panel: rgb(t.tokens.panel),
  text2: rgb(t.tokens.text2),
  text3: rgb(t.tokens.text3),
}));

/** What `--color-text-dim` resolves to, read out of the stylesheet rather than restated. */
function textDim(theme: (typeof themes)[number]): number[] {
  const m = /--color-text-dim:\s*color-mix\(in srgb, var\(--text-2\) (\d+)%, var\(--text-3\)\)/
    .exec(globals);
  expect(m, "globals.css no longer defines --color-text-dim as a text-2/text-3 mix").not.toBeNull();
  return mix(theme.text2, theme.text3, Number(m![1]) / 100);
}

describe("fading a row is not the same thing in both modes", () => {
  it("leaves a gitignored name unreadable on light and merely dim on dark", () => {
    // The hazard this test exists for. Both are below the 3:1 floor, but the
    // light figure is the one that made the subtree look empty.
    const worst = { light: Infinity, dark: Infinity };
    for (const t of themes) {
      const faded = contrast(mix(t.text2, t.panel, 0.4), t.panel);
      expect(faded, `${t.id}: opacity-40 is no longer a hazard?`).toBeLessThan(3);
      worst[t.mode] = Math.min(worst[t.mode], faded);
    }
    // Same knob, ~25% less contrast on light — which is the whole point.
    expect(worst.light).toBeLessThan(2);
    expect(worst.dark).toBeGreaterThan(worst.light);
  });
});

describe("the dim colour is legible in every built-in theme", () => {
  it("clears 3:1 against the panel, light and dark alike", () => {
    for (const t of themes) {
      expect(contrast(textDim(t), t.panel), `${t.id} text-dim`).toBeGreaterThan(3);
    }
  });

  it("still reads as dimmer than an ordinary file's name", () => {
    // If it landed on top of --text-2 the row would be legible and say nothing.
    for (const t of themes) {
      expect(contrast(textDim(t), t.panel), `${t.id}`)
        .toBeLessThan(contrast(t.text2, t.panel) - 0.5);
    }
  });
});

describe("the tree row uses it", () => {
  it("does not fade the row for the ignored state", () => {
    // `isCut` may stay a fade — it is a momentary state the user just caused.
    const row = treeNode.slice(treeNode.indexOf("<button"), treeNode.indexOf("{isDir ?"));
    expect(row).toContain(`isCut && "opacity-40"`);
    expect(row).not.toMatch(/isIgnored[^\n]*opacity-/);
  });

  it("colours the label with text-dim when ignored", () => {
    expect(treeNode).toMatch(/isIgnored\s*\n?\s*\?\s*"text-text-dim"/);
  });

  it("leaves the icon's artwork alone", () => {
    // The glyphs are background-image artwork: any opacity on them is the same
    // fade to the panel this whole file is about.
    const icon = treeNode.slice(treeNode.indexOf("<FileIcon"), treeNode.indexOf("/>", treeNode.indexOf("<FileIcon")));
    expect(icon).not.toContain("opacity");
  });
});
