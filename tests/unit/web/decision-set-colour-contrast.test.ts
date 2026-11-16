/**
 * The set of decisions draws amber (and red for urgent) as a pale tint with a strong outline and
 * "ink" text, never dark text on a solid fill — black on solid red read as an alarm. The ink is
 * the hue pulled toward the theme's text colour (`--color-warning-ink`, `--color-error-ink` in
 * globals.css), because the raw hue is too light to read on its own tint in the light themes.
 * This measures every built-in theme, light and dark, at the tints the set actually uses.
 */
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BUILTIN_THEMES } from "../../../src/web/theme/builtin/index.ts";

const read = (p: string) => readFileSync(resolve(import.meta.dir, "../../../src/web/", p), "utf8");
const globals = read("styles/globals.css");
const parts = read("components/chat/question-form-parts.tsx");
const buttons = read("components/assistant/cards/decision-set/decision-set-buttons.ts");

const rgb = (hex: string) => { const n = parseInt(hex.replace("#", "").slice(0, 6), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const luminance = ([r, g, b]: number[]) => {
  const c = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * c(r!) + 0.7152 * c(g!) + 0.0722 * c(b!);
};
const contrast = (a: number[], b: number[]) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};
/** `color-mix(in srgb, a P%, b)`, and an alpha tint over its backdrop, are the same maths. */
const mix = (a: number[], b: number[], p: number) => a.map((c, i) => c * p + b[i]! * (1 - p));

/** The ink's share of its hue, read out of the stylesheet rather than restated. */
function inkShare(hue: "warning" | "error"): number {
  const m = new RegExp(`--color-${hue}-ink:\\s*color-mix\\(in srgb, var\\(--${hue}\\) (\\d+)%, var\\(--text\\)\\)`).exec(globals);
  expect(m, `globals.css no longer defines --color-${hue}-ink as a ${hue}/text mix`).not.toBeNull();
  return Number(m![1]) / 100;
}

/** Every tint of `hue` the set's tone classes and buttons use (`bg-warning/15` → 0.15). */
function tints(hue: "warning" | "error"): number[] {
  const found = [...`${parts}\n${buttons}`.matchAll(new RegExp(`bg-${hue}/(\\d+)`, "g"))].map((m) => Number(m[1]) / 100);
  return [...new Set(found)];
}

describe("the set's amber and red", () => {
  for (const hue of ["warning", "error"] as const) {
    it(`${hue} ink reads at 4.5:1 or better on every tint the set uses, in every built-in theme`, () => {
      const share = inkShare(hue);
      const used = tints(hue);
      expect(used.length).toBeGreaterThan(0);
      const failures: string[] = [];
      for (const [id, theme] of Object.entries(BUILTIN_THEMES)) {
        const t = theme.tokens as Record<string, string>;
        const ink = mix(rgb(t[hue]!), rgb(t.text!), share);
        // The tab strip sits on the app's background, a card's chips on its panel.
        for (const ground of [t.bgSolid!, t.panel!]) {
          for (const a of used) {
            const ratio = contrast(ink, mix(rgb(t[hue]!), rgb(ground), a));
            if (ratio < 4.5) failures.push(`${id} ${hue}/${a * 100} on ${ground}: ${ratio.toFixed(2)}`);
          }
        }
      }
      expect(failures).toEqual([]);
    });

    it(`raw ${hue} as text is the hazard the ink exists for, on at least one light theme`, () => {
      const worst = Math.min(...Object.values(BUILTIN_THEMES).filter((t) => t.mode === "light").map((theme) => {
        const t = theme.tokens as Record<string, string>;
        return contrast(rgb(t[hue]!), mix(rgb(t[hue]!), rgb(t.bgSolid!), 0.15));
      }));
      expect(worst).toBeLessThan(4.5);
    });
  }

  it("no tone draws dark text on a solid amber or red fill", () => {
    for (const source of [parts, buttons]) {
      expect(source).not.toMatch(/bg-(warning|error) text-neutral-950/);
      expect(source).not.toMatch(/bg-(warning|error)(?![\/\w-])/);
    }
  });
});
