/**
 * A font stack is only a wish list until something ships the font.
 *
 * Every code surface named `Menlo, Monaco, Consolas` and every text surface
 * named `-apple-system, BlinkMacSystemFont, Segoe UI` — all of which miss on
 * Linux, where the generic fallbacks can resolve through fontconfig to
 * Liberation Sans and, for `sans-serif`, to Liberation *Serif*. So the app was
 * set in an Arial clone and the editor in whatever `fc-match monospace`
 * answered, on the platform PPM is most often self-hosted on.
 *
 * The fix has two halves that are useless apart: a stack whose first entry is a
 * real typeface, and an import that actually bundles that typeface. This test
 * pairs them, because a stack naming a font nothing ships is precisely the bug,
 * and it reads identically to the fixed version in review.
 */
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import {
  EDITOR_FONT_FAMILY,
  EDITOR_FONT_LIGATURES,
  EDITOR_FONT_SIZE,
  GHOST_TEXT_FONT_FAMILY,
  TERMINAL_FONT_FAMILY,
} from "../../../src/web/lib/editor-font.ts";

const entry = readFileSync("src/web/main.tsx", "utf8");
const globals = readFileSync("src/web/styles/globals.css", "utf8");

/** The family a stack asks for first, unquoted. */
function head(stack: string): string {
  return (stack.split(",")[0] ?? "").trim().replace(/^['"]|['"]$/g, "");
}

/** Families this bundle ships a face for, from the entry's side-effect imports. */
function bundledFamilies(): string[] {
  const families: string[] = [];
  for (const match of entry.matchAll(/^import "@fontsource(?:-variable)?\/([^/]+)\//gm)) {
    // @fontsource package names are the family, kebab-cased.
    families.push(
      match[1]
        .split("-")
        .map((word) => word[0].toUpperCase() + word.slice(1))
        .join(" "),
    );
  }
  return families;
}

describe("the fonts every surface asks for", () => {
  it("bundles the first family of every stack, rather than hoping for it", () => {
    const shipped = bundledFamilies();
    expect(shipped).toContain("Monaspace Argon");
    expect(shipped).toContain("Monaspace Krypton");
    expect(shipped).toContain("Geist");

    expect(head(EDITOR_FONT_FAMILY)).toBe("Monaspace Argon");
    expect(head(GHOST_TEXT_FONT_FAMILY)).toBe("Monaspace Krypton");
    // The app's text font is the variable build, whose family carries the suffix.
    expect(globals).toMatch(/--font-sans:\s*"Geist Variable"/);
    expect(globals).toMatch(/--font-mono:\s*"Monaspace Argon"/);
  });

  it("still names a font per platform behind the bundled one", () => {
    // A face can fail to load, and `monospace` alone is not a coding font —
    // it is whatever fc-match answers, which is the state this replaced.
    for (const stack of [EDITOR_FONT_FAMILY, GHOST_TEXT_FONT_FAMILY, TERMINAL_FONT_FAMILY]) {
      expect(stack).toContain("Consolas"); // Windows
      expect(stack).toContain("Menlo"); // macOS
      expect(stack).toContain("DejaVu Sans Mono"); // Linux
      expect(stack.endsWith("monospace")).toBe(true);
    }
    expect(globals).toMatch(/--font-sans:[^;]*system-ui/);
    // Not a bare sans-serif at the end of the sans stack with nothing before it.
    expect(globals).toMatch(/--font-sans:[^;]*"Noto Sans"[^;]*sans-serif;/);
  });

  it("names the installed superset behind the subset it bundles", () => {
    // A `@font-face` shadows a system font of the same family name *entirely*,
    // so the bundled Latin subset wins even on a host with the full Monaspace
    // installed — and a Vietnamese comment falls per-glyph to the platform
    // monospace while the right font sits unused. The variable build carries
    // its own family name, so naming it separately picks up exactly the glyphs
    // the subset lacks, in the same typeface.
    expect(EDITOR_FONT_FAMILY).toContain("'Monaspace Argon', 'Monaspace Argon Var'");
    expect(GHOST_TEXT_FONT_FAMILY).toContain("'Monaspace Krypton', 'Monaspace Krypton Var'");
    expect(globals).toMatch(/--font-sans:\s*"Geist Variable",\s*"Geist"/);
    expect(globals).toMatch(/--font-mono:\s*"Monaspace Argon",\s*"Monaspace Argon Var"/);
  });

  it("asks for the ligatures and every stylistic set", () => {
    // ss01-ss09 are where Monaspace's texture healing lives — the part that
    // narrows an i beside an m so `www.mmm.iii` stops looking like a fence.
    expect(EDITOR_FONT_LIGATURES).toContain("'calt'");
    expect(EDITOR_FONT_LIGATURES).toContain("'liga'");
    for (let set = 1; set <= 9; set++) {
      expect(EDITOR_FONT_LIGATURES).toContain(`'ss0${set}'`);
    }
    expect(EDITOR_FONT_SIZE).toBe(14);
  });

  it("gives every Monaco surface the same size, family and features", () => {
    // Three editors, one typeface: a diff pane in another font from the file it
    // came from is the drift this constant exists to stop.
    for (const file of ["code-editor.tsx", "conflict-editor.tsx", "diff-viewer.tsx"]) {
      const source = readFileSync(`src/web/components/editor/${file}`, "utf8");
      expect(source).toContain("fontFamily: EDITOR_FONT_FAMILY");
      expect(source).toContain("fontLigatures: EDITOR_FONT_LIGATURES");
      expect(source).toContain("EDITOR_FONT_SIZE");
      expect(source).not.toMatch(/fontSize: 13,/);
    }
  });

  it("wins the cascade against Monaco's own ghost-text rule", () => {
    // Monaco's `.monaco-editor .ghost-text-decoration` is the same specificity
    // and its stylesheet is appended by the AMD loader *after* this bundle, so
    // an equal-weight rule silently loses on source order.
    const rule = globals.slice(globals.indexOf(".monaco-editor .ghost-text-decoration"));
    expect(rule).toContain("Monaspace Krypton");
    expect(rule).toContain("!important");
  });

  it("keeps the terminal on a patched font, and does not bundle one", () => {
    // A prompt is full of powerline separators and devicons that only a Nerd
    // Font has. The patched faces are over a megabyte each, and a terminal has
    // to open on a phone, so it is used where installed and never shipped.
    expect(head(TERMINAL_FONT_FAMILY)).toContain("Nerd Font");
    expect(TERMINAL_FONT_FAMILY).toContain("Monaspace Argon");
    expect(entry).not.toContain("Meslo");
    expect(entry).not.toContain("nerd");
  });

  it("re-measures the terminal once a webfont lands", () => {
    // xterm bakes the cell size and the glyph atlas from ctx.font at open(),
    // so a terminal opened during the first paint would keep the fallback it
    // resolved then for the rest of the session.
    const terminal = readFileSync("src/web/hooks/use-terminal.ts", "utf8");
    expect(terminal).toContain("document.fonts.ready");
    expect(terminal).toContain("fitAddon.fit()");
  });
});
