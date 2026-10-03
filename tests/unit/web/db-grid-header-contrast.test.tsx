/**
 * A column's title over the header behind it, while a cell of that column is the current one or
 * the pointer is over its title.
 *
 * Both headers were filled with the accent itself, while the title on them kept the ink it has on
 * the plain header — measured against PPM's six themes, a nullable column's name stood at 1.0–1.6:1
 * there and the sort arrow, drawn in the accent, at exactly 1:1: the title of the very column being
 * worked in, unreadable, its sort gone. Only a whole selected column is filled with the accent, and
 * its title is drawn in the colour made for that (`accentFg`, `grid/header-bands.ts`).
 *
 * The grid's theme is read from the app's `--color-*` variables, so each theme's tokens are set on
 * `<html>` the way `globals.css` maps them, read out of the stylesheet rather than restated.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { installDom, installGlobal, mount, uninstallDom } from "../../helpers/react-dom.tsx";

installDom();
// The theme follows <html>'s class with one.
installGlobal("MutationObserver", window.MutationObserver);
afterAll(uninstallDom);

const { BUILTIN_THEMES } = await import("../../../src/web/theme/builtin/index.ts");
const { useGlideTheme } = await import("../../../src/web/components/database/glide-grid-theme.ts");
type Theme = import("@glideapps/glide-data-grid").Theme;

const globals = readFileSync(resolve(import.meta.dir, "../../../src/web/styles/globals.css"), "utf8");
/** `--color-muted: var(--panel);` → `--color-muted` names the theme token `panel`. */
const aliases = [...globals.matchAll(/(--color-[\w-]+):\s*var\(--([\w-]+)\);/g)].map(([, alias, token]) => ({
  alias: alias!,
  token: token!.replace(/-(\w)/g, (_, c: string) => c.toUpperCase()),
}));

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
/** A `#rrggbb`, `rgb()` or `rgba()` colour as RGBA. */
function parse(color: string): number[] {
  if (color.startsWith("#")) {
    const n = parseInt(color.slice(1, 7), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  const [r, g, b, a = 1] = color.replace(/^rgba?\(|\)$/g, "").split(/[\s,/]+/).filter(Boolean).map(Number);
  return [r!, g!, b!, a];
}
/** What a fill looks like once painted over the header, as Glide paints it. */
function over(fill: string, header: string): number[] {
  const [r, g, b, a] = parse(fill);
  const base = parse(header);
  return [r!, g!, b!].map((c, i) => c * a! + base[i]! * (1 - a!));
}

/** The grid's theme with one of PPM's themes applied. */
async function gridThemeFor(tokens: Record<string, string>): Promise<Partial<Theme>> {
  const root = document.documentElement;
  for (const { alias, token } of aliases) if (tokens[token]) root.style.setProperty(alias, tokens[token]);
  let theme: Partial<Theme> = {};
  function Probe() {
    theme = useGlideTheme();
    return null;
  }
  const view = await mount(<Probe />);
  await view.unmount();
  return theme;
}

// One at a time: they share <html>.
const themes: { id: string; tokens: Record<string, string>; grid: Partial<Theme> }[] = [];
for (const [id, t] of Object.entries(BUILTIN_THEMES)) {
  const tokens = t.tokens as unknown as Record<string, string>;
  themes.push({ id, tokens, grid: await gridThemeFor(tokens) });
}

describe("a title over the header of the column being worked in", () => {
  it("reads the app's colours, not a theme of its own", () => {
    // Otherwise everything below measures nothing.
    expect(themes.length).toBeGreaterThanOrEqual(6);
    for (const { tokens, grid } of themes) {
      expect(grid.bgHeader).toBe(tokens.panel);
      expect(grid.accentColor).toBe(tokens.accent);
    }
  });

  it("was unreadable on the accent itself", () => {
    expect(themes.some(({ grid }) => contrast(parse(grid.textHeader!), parse(grid.accentColor!)) < 1.5)).toBe(true);
  });

  for (const state of ["bgHeaderHasFocus", "bgHeaderHovered"] as const) {
    it(`keeps every part of the title readable on ${state}`, () => {
      // Text at 4.5:1; the sort arrow is a graphic, which WCAG holds to 3:1.
      const parts = [["name", "textHeader", 4.5], ["NOT NULL name", "textDark", 4.5], ["sort arrow", "accentColor", 3]] as const;
      const unreadable = themes.flatMap(({ id, grid }) => {
        const fill = over(grid[state]!, grid.bgHeader!);
        return parts
          .map(([part, ink, min]) => ({ part, ratio: contrast(parse(grid[ink]!), fill), min }))
          .filter(({ ratio, min }) => ratio < min)
          .map(({ part, ratio }) => `${id}: ${part} at ${ratio.toFixed(2)}:1`);
      });
      expect(unreadable).toEqual([]);
    });

    it(`still sets ${state} apart from the plain header`, () => {
      for (const { grid } of themes) expect(contrast(over(grid[state]!, grid.bgHeader!), parse(grid.bgHeader!))).toBeGreaterThan(1.05);
    });
  }
});
