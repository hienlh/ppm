/**
 * The bundled Nerd Font symbols: the stylesheet, the files and the stack have
 * to stay in step, and every way they can drift fails silently.
 *
 * A `@font-face` naming a file that is not committed renders tofu. A face with
 * no `unicode-range` is downloaded by everybody on every visit — 500 KiB of
 * Material Design icons in the boot shell, which is the exact opposite of why
 * this is split into fourteen files. A stack that stops naming the family
 * renders tofu again, with all fourteen sitting unused in the bundle. None of
 * that is visible in review and none of it throws.
 *
 * Regenerate with `bun scripts/gen-nerd-font.ts` after editing its `BLOCKS`.
 */
import { describe, it, expect } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { TERMINAL_FONT_FAMILY } from "../../../src/web/lib/editor-font.ts";

const ROOT = resolve(import.meta.dir, "../../..");
const FONT_DIR = resolve(ROOT, "src/web/styles/fonts");
const FAMILY = "PPM Nerd Symbols";

const css = readFileSync(resolve(ROOT, "src/web/styles/nerd-font.generated.css"), "utf8");
const mainTsx = readFileSync(resolve(ROOT, "src/web/main.tsx"), "utf8");
const useTerminal = readFileSync(resolve(ROOT, "src/web/hooks/use-terminal.ts"), "utf8");
const viteConfig = readFileSync(resolve(ROOT, "vite.config.ts"), "utf8");
const precompress = readFileSync(resolve(ROOT, "scripts/precompress-web.ts"), "utf8");

interface Face {
  family: string;
  file: string;
  ranges: [number, number][];
}

/** Every `@font-face` the generated stylesheet declares. */
const faces: Face[] = [...css.matchAll(/@font-face \{([^}]*)\}/g)].map((m) => {
  const body = m[1]!;
  const family = /font-family: "([^"]+)"/.exec(body)?.[1] ?? "";
  const file = /src: url\("\.\/fonts\/([^"]+)"\)/.exec(body)?.[1] ?? "";
  const declared = /unicode-range: ([^;]+);/.exec(body)?.[1] ?? "";
  const ranges = [...declared.matchAll(/U\+([0-9A-F]+)(?:-([0-9A-F]+))?/g)].map(
    (r) => [parseInt(r[1]!, 16), parseInt(r[2] ?? r[1]!, 16)] as [number, number],
  );
  return { family, file, ranges };
});

const committed = readdirSync(FONT_DIR).filter((f) => f.endsWith(".woff2"));

describe("the generated stylesheet and the committed faces agree", () => {
  it("declares a face per block, and this is the reviewed count", () => {
    // Pinned so a block silently dropped from `BLOCKS` fails here rather than
    // as a handful of icons nobody notices are gone.
    expect(faces).toHaveLength(14);
    expect(committed).toHaveLength(14);
  });

  it("points every face at a file that exists", () => {
    const missing = faces.filter((f) => !committed.includes(f.file)).map((f) => f.file);
    expect(missing).toEqual([]);
  });

  it("references every committed file, so nothing ships unreachable", () => {
    const named = new Set(faces.map((f) => f.file));
    expect(committed.filter((f) => !named.has(f))).toEqual([]);
  });

  it("ships real woff2, not a stub or an HTML error page", () => {
    // A truncated or mis-copied file is a face the browser rejects, which
    // renders as tofu — the very thing this replaced.
    for (const file of committed) {
      const head = readFileSync(resolve(FONT_DIR, file)).subarray(0, 4).toString("latin1");
      expect(head, file).toBe("wOF2");
    }
  });

  it("names one family, and it is not a real installed font's", () => {
    // A `@font-face` shadows a system font of the same family name completely,
    // so calling this `Symbols Nerd Font Mono` would replace a real local
    // install's 10,624 glyphs with this subset's.
    expect([...new Set(faces.map((f) => f.family))]).toEqual([FAMILY]);
  });
});

describe("each face is fetched only when something draws it", () => {
  it("gives every face a unicode-range", () => {
    // Without one, the face is a candidate for *all* text and the browser
    // fetches it on the first character of the terminal — all 1.1 MB of it.
    const unbounded = faces.filter((f) => f.ranges.length === 0).map((f) => f.file);
    expect(unbounded).toEqual([]);
  });

  it("never lets two faces claim the same codepoint", () => {
    // An overlap downloads a second 500 KiB file to draw a glyph already in
    // hand, and which of the two wins is declaration order — invisible either
    // way, since both draw the same icon.
    const seen = new Map<number, string>();
    const clashes: string[] = [];
    for (const face of faces) {
      for (const [a, b] of face.ranges) {
        for (let cp = a; cp <= b; cp++) {
          const other = seen.get(cp);
          if (other && other !== face.file) {
            clashes.push(`U+${cp.toString(16).toUpperCase()}: ${other} and ${face.file}`);
          } else seen.set(cp, face.file);
        }
      }
    }
    expect(clashes.slice(0, 5)).toEqual([]);
  });

  it("keeps the block a powerline prompt needs cheap", () => {
    // Nearly every themed prompt draws these separators and most draw nothing
    // else, so this one face is what the feature actually costs in practice.
    const powerline = faces.find((f) => f.file.includes("powerline"))!;
    expect(powerline).toBeDefined();
    expect(statSync(resolve(FONT_DIR, powerline.file)).size).toBeLessThan(16 * 1024);
  });

  it("stays inside the size budget that was agreed", () => {
    // The ceiling nobody reaches — no prompt draws from every block — but a
    // regeneration that stopped subsetting would land here.
    const total = committed.reduce((n, f) => n + statSync(resolve(FONT_DIR, f)).size, 0);
    expect(total).toBeLessThan(1.25 * 1024 * 1024);
    expect(total).toBeGreaterThan(1.0 * 1024 * 1024);
  });

  it("is never inlined into the stylesheet by the bundler", () => {
    // Vite's 4 KB default base64'd the four smallest faces into the entry CSS,
    // which is the one file the service worker precaches: the *rarest* blocks
    // became an unconditional download for everyone.
    expect(viteConfig).toMatch(/assetsInlineLimit[\s\S]{0,120}woff2/);
  });

  it("is left out of the precache and of the compressed siblings", () => {
    const globs = /globPatterns: \[([^\]]*)\]/.exec(viteConfig)?.[1] ?? "";
    // Asserted non-empty first: a renamed option would make the `not.toMatch`
    // below pass against an empty string and say nothing at all.
    expect(globs).not.toBe("");
    expect(globs).not.toMatch(/woff|font/i);
    // woff2 is already compressed; a `.br` sibling is a bigger file nobody wants.
    const compressible = /const COMPRESSIBLE = new Set\(\[([^\]]*)\]/.exec(precompress)?.[1] ?? "";
    expect(compressible).toContain(".css");
    expect(compressible).not.toMatch(/woff/);
  });
});

describe("the terminal's stack reaches the bundled face", () => {
  it("names it", () => {
    expect(TERMINAL_FONT_FAMILY).toContain(`'${FAMILY}'`);
  });

  it("puts it behind a fully patched local font and ahead of the text face", () => {
    // Every name is looked up rather than assumed present: `indexOf` answers
    // -1 for a missing one, and -1 is less than any real position — so a
    // dropped entry would satisfy the ordering checks below while meaning the
    // opposite.
    const at = (name: string) => {
      const i = TERMINAL_FONT_FAMILY.indexOf(name);
      expect(i, name).toBeGreaterThanOrEqual(0);
      return i;
    };
    // A real patched install draws the icons *and* the letters in one typeface
    // at metrics fitted together, so it must keep winning.
    expect(at("MesloLGM Nerd Font")).toBeLessThan(at(FAMILY));
    expect(at("Symbols Nerd Font'")).toBeLessThan(at(FAMILY));
    // Ahead of Monaspace so the few icons in this set that are real Unicode
    // (`⚡`, `♥`) are drawn one cell wide with the rest of the prompt.
    expect(at(FAMILY)).toBeLessThan(at("Monaspace Argon"));
  });

  it("loads the stylesheet, or the faces do not exist at all", () => {
    expect(mainTsx).toMatch(/import "\.\/styles\/nerd-font\.generated\.css"/);
  });
});

describe("a face that lands late still gets drawn", () => {
  it("throws away xterm's glyph atlas when a font finishes loading", () => {
    // Measured: a canvas `fillText` does start the fetch, but the tofu it
    // painted stays — the atlas is cached and nothing repaints it, so the
    // prompt is wrong for the rest of the session with the right font loaded
    // in the page. With the listener's body removed, glyph rasterisations after
    // the face landed were +0; with it, +14.
    expect(useTerminal).toMatch(/addEventListener\("loadingdone"/);
    expect(useTerminal).toMatch(/clearTextureAtlas\(\)/);
    expect(useTerminal).toMatch(/term\.refresh\(0, term\.rows - 1\)/);
  });

  it("does not rely on document.fonts.ready for it", () => {
    // `ready` resolves once, long before a prompt first draws a Private Use
    // Area character and triggers the fetch — which is why the one-shot
    // re-measure already there cannot be the whole answer.
    const idx = useTerminal.indexOf('addEventListener("loadingdone"');
    expect(idx).toBeGreaterThan(0);
    expect(useTerminal).toMatch(/removeEventListener\("loadingdone", onFontLoaded\)/);
  });
});
