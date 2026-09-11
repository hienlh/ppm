/**
 * Vendor the Nerd Fonts symbol glyphs the terminal's prompt is drawn from.
 *
 * A shell prompt is mostly icons: oh-my-posh, powerlevel10k and starship all
 * draw their segment separators, git status and language badges from Private
 * Use Area codepoints that only a *patched* font has. PPM asked for three of
 * them by name and bundled none, so on any machine without one installed every
 * one of those characters rendered as tofu — while `↑`/`↓` beside them drew
 * fine, because those two are real Unicode. That asymmetry is the tell.
 *
 * The patched full faces are over a megabyte each, which is why they were left
 * unbundled. The symbols-only face is not much better at 2.5 MB of TTF — but
 * nothing needs all of it at once. Split per icon block, each `@font-face`
 * carries its own `unicode-range`, and a browser fetches a face only when it
 * actually lays out a character inside it: a powerline prompt costs 7 KiB, and
 * the 492 KiB of Material Design icons is downloaded by whoever draws one and
 * by nobody else.
 *
 * Both artifacts are committed. Re-run after editing `BLOCKS`:
 *
 *   bun scripts/gen-nerd-font.ts
 */
import subsetFont from "subset-font";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Pinned, and checked against a digest rather than trusted.
 *
 * A git tag can be moved and a release asset replaced, so "download the latest"
 * makes the committed `.woff2` unreproducible — and a font that changed under us
 * shifts every glyph in the terminal with nothing to point at. The single file
 * from the repository tree is byte-identical to the one inside the release's
 * `NerdFontsSymbolsOnly.tar.xz`, and needs neither `tar` nor `xz` to unpack, so
 * this script runs anywhere Bun does.
 */
const VERSION = "v3.5.1";
const SOURCE_URL =
  `https://raw.githubusercontent.com/ryanoasis/nerd-fonts/${VERSION}` +
  `/patched-fonts/NerdFontsSymbolsOnly/SymbolsNerdFontMono-Regular.ttf`;
const SOURCE_SHA256 = "fe471e538392f51910faab985fa8e192a39dd3426125edd15b71b3680df0e749";

/**
 * The *Mono* variant, whose every advance is exactly one em — a terminal places
 * characters on a grid, and the proportional variant's wider icons would each
 * push the rest of the line out of its cells.
 *
 * The family name is PPM's own rather than the real `Symbols Nerd Font Mono`,
 * because a `@font-face` shadows a system font of the same family name
 * completely: on a host where the real thing is installed, naming it here would
 * replace all 10,624 of its glyphs with this subset's.
 */
const FAMILY = "PPM Nerd Symbols";

const OUT_FONT_DIR = resolve(import.meta.dir, "../src/web/styles/fonts");
const OUT_CSS = resolve(import.meta.dir, "../src/web/styles/nerd-font.generated.css");
const FILE_PREFIX = "nerd-symbols-";

interface Block {
  /** Filename and CSS comment key. */
  slug: string;
  /** Nerd Fonts' own name for the set, as the cheat sheet lists it. */
  label: string;
  ranges: readonly (readonly [number, number])[];
}

/**
 * One face per icon set, because the split *is* the optimisation.
 *
 * Ranges are the source font's actual coverage, not the ones documented on the
 * cheat sheet — v3.5.1 runs Devicons to `E958` and Codicons to `EC84`, well past
 * where the published tables stop. `assertFullCoverage` below is what keeps that
 * honest across a version bump.
 */
const BLOCKS: readonly Block[] = [
  // The strays first: these are real Unicode rather than Private Use Area, so
  // they are the only ones a system font might also have. They are kept here
  // anyway — a prompt drawing `⚡` wants the single-cell icon beside its other
  // segments, not a double-width emoji from a fallback font.
  { slug: "iec-power", label: "IEC Power Symbols", ranges: [[0x23fb, 0x23fe], [0x2b58, 0x2b58]] },
  {
    slug: "misc",
    label: "Octicons and Powerline Extra strays",
    ranges: [[0x2630, 0x2630], [0x2665, 0x2665], [0x26a1, 0x26a1], [0x276c, 0x2771]],
  },
  { slug: "pomicons", label: "Pomicons", ranges: [[0xe000, 0xe00a]] },
  // The one nearly every prompt needs, and the cheapest.
  { slug: "powerline", label: "Powerline + Powerline Extra", ranges: [[0xe0a0, 0xe0a3], [0xe0b0, 0xe0d7]] },
  { slug: "font-awesome-ext", label: "Font Awesome Extension", ranges: [[0xe200, 0xe2a9]] },
  { slug: "weather", label: "Weather", ranges: [[0xe300, 0xe3e3]] },
  { slug: "seti", label: "Seti-UI + Custom", ranges: [[0xe5fa, 0xe6bb]] },
  { slug: "devicons", label: "Devicons", ranges: [[0xe700, 0xe958]] },
  { slug: "codicons", label: "Codicons", ranges: [[0xea60, 0xec84]] },
  { slug: "font-awesome", label: "Font Awesome", ranges: [[0xed00, 0xefcf]] },
  { slug: "font-awesome-legacy", label: "Font Awesome (legacy range)", ranges: [[0xf000, 0xf2ff]] },
  { slug: "font-logos", label: "Font Logos", ranges: [[0xf300, 0xf385]] },
  { slug: "octicons", label: "Octicons", ranges: [[0xf400, 0xf533]] },
  // Half the total weight on its own, and the reason none of this is one file.
  { slug: "material", label: "Material Design Icons", ranges: [[0xf0001, 0xf1af0]] },
];

/**
 * Every codepoint the source font maps, from its format-12 cmap subtable.
 *
 * Read directly rather than with a font library because it answers one
 * question, and the answer is what makes a version bump safe: a block added
 * upstream that `BLOCKS` does not list would otherwise ship as glyphs nothing
 * can reach — tofu again, with no error anywhere to say so.
 */
function mappedCodepoints(ttf: Buffer): Set<number> {
  const tables = ttf.readUInt16BE(4);
  let cmap = 0;
  for (let i = 0; i < tables; i++) {
    const rec = 12 + i * 16;
    if (ttf.toString("latin1", rec, rec + 4) === "cmap") cmap = ttf.readUInt32BE(rec + 8);
  }
  if (!cmap) throw new Error("source font has no cmap table");

  let format12 = 0;
  const subtables = ttf.readUInt16BE(cmap + 2);
  for (let i = 0; i < subtables; i++) {
    const off = cmap + ttf.readUInt32BE(cmap + 4 + i * 8 + 4);
    if (ttf.readUInt16BE(off) === 12) format12 = off;
  }
  // Format 4 is 16-bit only, and the Material Design icons live above U+FFFF —
  // so a font without a format-12 subtable is not the font this expects.
  if (!format12) throw new Error("source font has no format-12 cmap subtable");

  const out = new Set<number>();
  const groups = ttf.readUInt32BE(format12 + 12);
  for (let g = 0; g < groups; g++) {
    const rec = format12 + 16 + g * 12;
    const end = ttf.readUInt32BE(rec + 4);
    for (let cp = ttf.readUInt32BE(rec); cp <= end; cp++) out.add(cp);
  }
  return out;
}

const inBlock = (cp: number, block: Block) =>
  block.ranges.some(([a, b]) => cp >= a && cp <= b);

function assertFullCoverage(font: Set<number>) {
  const orphans = [...font].filter((cp) => !BLOCKS.some((b) => inBlock(cp, b)));
  if (orphans.length === 0) return;
  const shown = orphans.slice(0, 12).map((cp) => `U+${cp.toString(16).toUpperCase()}`);
  throw new Error(
    `${orphans.length} codepoints in ${VERSION} fall in no block, so their glyphs ` +
      `would ship unreachable: ${shown.join(", ")}${orphans.length > shown.length ? ", …" : ""}\n` +
      `Add the range to BLOCKS.`,
  );
}

const hex = (cp: number) => cp.toString(16).toUpperCase().padStart(4, "0");
const cssRange = (block: Block) =>
  block.ranges.map(([a, b]) => (a === b ? `U+${hex(a)}` : `U+${hex(a)}-${hex(b)}`)).join(", ");

// ---------------------------------------------------------------------------

const res = await fetch(SOURCE_URL);
if (!res.ok) throw new Error(`${SOURCE_URL} → ${res.status} ${res.statusText}`);
const ttf = Buffer.from(await res.arrayBuffer());

const digest = createHash("sha256").update(ttf).digest("hex");
if (digest !== SOURCE_SHA256) {
  throw new Error(
    `SymbolsNerdFontMono-Regular.ttf at ${VERSION} is not the reviewed file.\n` +
      `  expected ${SOURCE_SHA256}\n  got      ${digest}\n` +
      `A moved tag or a replaced asset shifts every glyph in the terminal. ` +
      `Review the new file, then update SOURCE_SHA256.`,
  );
}

const mapped = mappedCodepoints(ttf);
assertFullCoverage(mapped);

mkdirSync(OUT_FONT_DIR, { recursive: true });

const faces: { block: Block; file: string; bytes: number; glyphs: number }[] = [];
for (const block of BLOCKS) {
  const text = [...mapped]
    .filter((cp) => inBlock(cp, block))
    .map((cp) => String.fromCodePoint(cp))
    .join("");
  const woff2 = await subsetFont(ttf, text, { targetFormat: "woff2" });
  const file = `${FILE_PREFIX}${block.slug}.woff2`;
  writeFileSync(resolve(OUT_FONT_DIR, file), woff2);
  faces.push({ block, file, bytes: woff2.length, glyphs: [...text].length });
}

// A renamed block leaves its old file behind, and an orphan `.woff2` is 500 KiB
// nothing references.
const keep = new Set(faces.map((f) => f.file));
for (const name of readdirSync(OUT_FONT_DIR)) {
  if (name.startsWith(FILE_PREFIX) && name.endsWith(".woff2") && !keep.has(name)) {
    rmSync(resolve(OUT_FONT_DIR, name));
    console.log(`nerd font  removed stale ${name}`);
  }
}

const kib = (n: number) => `${(n / 1024).toFixed(1)} KiB`;
const css = `/*
 * Generated by \`bun scripts/gen-nerd-font.ts\` — do not edit.
 *
 * Nerd Fonts ${VERSION}, symbols-only face, subset per icon block. Each face is
 * fetched only when a character inside its \`unicode-range\` is actually laid
 * out, so the total below is a ceiling nothing reaches: a powerline prompt
 * costs ${kib(faces.find((f) => f.block.slug === "powerline")!.bytes)}.
 *
 * \`font-display: swap\` throughout: the fallback shows at once and the icon
 * replaces it, where \`block\` would leave the cell empty for up to three
 * seconds instead.
 *
 * Nerd Fonts (MIT, ryanoasis/nerd-fonts).
 */
${faces
  .map(
    ({ block, file, bytes, glyphs }) => `/* ${block.label} — ${glyphs} glyphs, ${kib(bytes)} */
@font-face {
  font-family: "${FAMILY}";
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url("./fonts/${file}") format("woff2");
  unicode-range: ${cssRange(block)};
}`,
  )
  .join("\n\n")}
`;
writeFileSync(OUT_CSS, css);

const total = faces.reduce((n, f) => n + f.bytes, 0);
const glyphs = faces.reduce((n, f) => n + f.glyphs, 0);
console.log(
  `nerd font  ${faces.length} faces  ${glyphs} glyphs  ${kib(total)} if every block were fetched`,
);
for (const f of [...faces].sort((a, b) => b.bytes - a.bytes)) {
  console.log(`           ${f.block.slug.padEnd(21)} ${String(f.glyphs).padStart(5)} glyphs  ${kib(f.bytes).padStart(9)}`);
}
