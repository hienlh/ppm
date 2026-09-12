/**
 * A Tailwind colour class naming a token that does not exist emits NO rule, and
 * nothing anywhere reports it — not the build, not the browser, not review.
 *
 * `bg-surface-hover` was written against `--surface-hover`, which only ever
 * existed inside the webview panels' injected stylesheet. In the app it resolved
 * to nothing, so for as long as it has been in the tree every use was a silent
 * no-op: no hover feedback on any Processes, Services or Apps row, and the
 * memory composition bar, the partition bars, the Performance sidebar sparkline
 * tracks and the Overview per-core strip all painted their track
 * `rgba(0, 0, 0, 0)` — measured at a contrast ratio of 1.00 against the card.
 *
 * The class reads perfectly well, which is the whole problem. This pins the
 * colour tokens the System Monitor's classes name against the ones `globals.css`
 * actually defines.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const WEB = join(import.meta.dir, "../../../src/web");
const GLOBALS = join(WEB, "styles/globals.css");

/** `--color-<name>` declarations in the `@theme` block: the full set of colour
 *  names Tailwind can build a utility from. */
function definedColorTokens(): Set<string> {
  const css = readFileSync(GLOBALS, "utf-8");
  return new Set([...css.matchAll(/^\s*--color-([a-z0-9-]+)\s*:/gm)].map((m) => m[1]!));
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...sourceFiles(p));
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

/** Colour utilities whose token is a bare custom name. Anything with a slash
 *  opacity (`bg-primary/10`), an arbitrary value (`bg-[#fff]`) or a var
 *  reference is left alone — only the token name matters here. */
const CLASS_RE = /\b(?:bg|text|border|from|to|via|ring|fill|stroke|shadow|outline|decoration|divide|accent|caret|placeholder)-([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\b/g;

/** Tailwind's own built-in palette and keywords, which need no `--color-*`. */
const BUILTIN = new Set([
  "transparent", "current", "inherit", "black", "white", "auto", "none", "left", "right",
  "center", "justify", "start", "end", "top", "bottom", "clip", "ellipsis", "wrap", "nowrap",
  "balance", "pretty", "solid", "dashed", "dotted", "double", "hidden", "xs", "sm", "base",
  "lg", "xl", "2xl", "3xl", "4xl", "5xl", "6xl", "7xl", "8xl", "9xl", "inner", "2xs",
]);

const SCALED = /-(?:50|100|200|300|400|500|600|700|800|900|950)$/;

describe("every colour token a System Monitor class names is defined", () => {
  const defined = definedColorTokens();

  test("globals.css really does define the tokens this test reads", () => {
    // Guards the regex above: if the file's shape changes, the whole suite would
    // otherwise pass by finding nothing to check.
    expect(defined.size).toBeGreaterThan(20);
    expect(defined.has("panel")).toBe(true);
    expect(defined.has("text-dim")).toBe(true);
  });

  test("surface-hover is defined — 21 System Monitor classes depend on it", () => {
    expect(defined.has("surface-hover")).toBe(true);
  });

  test("no class in src/web/components/system names an undefined token", () => {
    const unknown = new Map<string, string[]>();
    for (const file of sourceFiles(join(WEB, "components/system"))) {
      const src = readFileSync(file, "utf-8");
      for (const m of src.matchAll(CLASS_RE)) {
        const token = m[1]!;
        if (BUILTIN.has(token) || SCALED.test(token)) continue;
        // Tailwind's own non-colour utilities share these prefixes (`text-left`,
        // `border-2`); a token that is not in globals.css and not a colour name
        // we recognise is only interesting if it LOOKS like a theme token.
        if (!/^(?:bg|text|border|ring|fill|stroke|divide|accent|caret|placeholder|from|to|via|shadow|outline|decoration)/.test(m[0])) continue;
        if (defined.has(token)) continue;
        if (!/^(?:surface|panel|rail|text|border|accent|success|warning|error|info|primary)/.test(token)) continue;
        unknown.set(token, [...(unknown.get(token) ?? []), file.replace(WEB, "src/web")]);
      }
    }
    expect(Object.fromEntries(unknown)).toEqual({});
  });
});
