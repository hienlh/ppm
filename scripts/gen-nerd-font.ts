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
import { writeNotices } from "./third-party-notices.ts";

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

/**
 * Who drew each set, and under what terms.
 *
 * Versions and upstreams are Nerd Fonts' own `src/glyphs/README.md` table for
 * the tag pinned above; the licence column is the upstream licence *text*,
 * checked against each project rather than copied from that table. They differ
 * in one place and it matters: the table records Font Logos as "unlicensed",
 * while the repository ships a verbatim copy of The Unlicense — a dedication
 * to the public domain, which is the opposite of having no terms.
 *
 * Keyed rather than inlined because a block can draw on two of these and two
 * blocks can draw on one, and an attribution list that repeats a project or
 * misses one is worth nothing.
 */
const SOURCES = {
  codicons: { name: "Codicons", upstream: "https://github.com/microsoft/vscode-codicons", version: "0.0.45", license: "CC-BY-4.0", holder: "Microsoft Corporation" },
  devicons: { name: "Devicons", upstream: "https://github.com/devicons/devicon", version: "2.17.0", license: "MIT", holder: "konpa" },
  "font-awesome": { name: "Font Awesome Free", upstream: "https://github.com/FortAwesome/Font-Awesome", version: "6.5.1", license: "CC-BY-4.0 (icons), OFL-1.1 (fonts)", holder: "Fonticons, Inc." },
  "font-awesome-extension": { name: "Font Awesome Extension", upstream: "https://github.com/AndreLZGava/font-awesome-extension", version: "0.0.3", license: "MIT", holder: "Andr\u00e9 Luiz Gava" },
  "font-logos": { name: "Font Logos", upstream: "https://github.com/Lukas-W/font-logos", version: "1.3.0", license: "Unlicense", holder: "Lukas W" },
  material: { name: "Material Design Icons", upstream: "https://github.com/Templarian/MaterialDesign-Font", version: "Oct 6, 2022", license: "Apache-2.0", holder: "Pictogrammers" },
  "nerd-fonts": { name: "Nerd Fonts (patcher and its own Custom glyphs)", upstream: "https://github.com/ryanoasis/nerd-fonts", version: VERSION, license: "MIT", holder: "Ryan L McIntyre" },
  octicons: { name: "Octicons", upstream: "https://github.com/primer/octicons", version: "18.3.0", license: "MIT", holder: "GitHub Inc." },
  "iec-power": { name: "Unicode Power Symbols", upstream: "https://github.com/jloughry/Unicode", version: "Feb 2015", license: "MIT", holder: "Joe Loughry" },
  pomicons: { name: "Pomicons", upstream: "https://github.com/gabrielelana/pomicons", version: "1.001", license: "OFL-1.1", holder: "Gabriele Lana" },
  powerline: { name: "Powerline Symbols", upstream: "https://github.com/powerline/powerline", version: "1.000", license: "MIT", holder: "Kim Silkeb\u00e6kken and other contributors" },
  "powerline-extra": { name: "Powerline Extra Symbols", upstream: "https://github.com/ryanoasis/powerline-extra-symbols", version: "1.200", license: "MIT", holder: "Ryan L McIntyre" },
  seti: { name: "Seti UI", upstream: "https://github.com/jesseweed/seti-ui", version: "0.8.1", license: "MIT", holder: "Jesse Weed" },
  weather: { name: "Weather Icons", upstream: "https://github.com/erikflowers/weather-icons", version: "2.0.10", license: "OFL-1.1", holder: "Erik Flowers, artwork by Lukas Bischoff" },
} as const;

type SourceId = keyof typeof SOURCES;

interface Block {
  /** Filename and CSS comment key. */
  slug: string;
  /** Nerd Fonts' own name for the set, as the cheat sheet lists it. */
  label: string;
  ranges: readonly (readonly [number, number])[];
  /**
   * Whose artwork ends up in this face. Required, so a block added in a
   * version bump cannot ship with nobody credited.
   */
  sources: readonly SourceId[];
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
  { slug: "iec-power", label: "IEC Power Symbols", ranges: [[0x23fb, 0x23fe], [0x2b58, 0x2b58]], sources: ["iec-power"] },
  {
    slug: "misc",
    label: "Octicons and Powerline Extra strays",
    ranges: [[0x2630, 0x2630], [0x2665, 0x2665], [0x26a1, 0x26a1], [0x276c, 0x2771]],
    sources: ["octicons", "powerline-extra"],
  },
  { slug: "pomicons", label: "Pomicons", ranges: [[0xe000, 0xe00a]], sources: ["pomicons"] },
  // The one nearly every prompt needs, and the cheapest.
  { slug: "powerline", label: "Powerline + Powerline Extra", ranges: [[0xe0a0, 0xe0a3], [0xe0b0, 0xe0d7]], sources: ["powerline", "powerline-extra"] },
  { slug: "font-awesome-ext", label: "Font Awesome Extension", ranges: [[0xe200, 0xe2a9]], sources: ["font-awesome-extension"] },
  { slug: "weather", label: "Weather", ranges: [[0xe300, 0xe3e3]], sources: ["weather"] },
  { slug: "seti", label: "Seti-UI + Custom", ranges: [[0xe5fa, 0xe6bb]], sources: ["seti", "nerd-fonts"] },
  { slug: "devicons", label: "Devicons", ranges: [[0xe700, 0xe958]], sources: ["devicons"] },
  { slug: "codicons", label: "Codicons", ranges: [[0xea60, 0xec84]], sources: ["codicons"] },
  { slug: "font-awesome", label: "Font Awesome", ranges: [[0xed00, 0xefcf]], sources: ["font-awesome"] },
  { slug: "font-awesome-legacy", label: "Font Awesome (legacy range)", ranges: [[0xf000, 0xf2ff]], sources: ["font-awesome"] },
  { slug: "font-logos", label: "Font Logos", ranges: [[0xf300, 0xf385]], sources: ["font-logos"] },
  { slug: "octicons", label: "Octicons", ranges: [[0xf400, 0xf533]], sources: ["octicons"] },
  // Half the total weight on its own, and the reason none of this is one file.
  { slug: "material", label: "Material Design Icons", ranges: [[0xf0001, 0xf1af0]], sources: ["material"] },
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

/**
 * The faces are the one thing PPM ships that is somebody else's work in its
 * original form — 14 `.woff2` files carved out of Nerd Fonts, sitting in the
 * tarball under names that say nothing about where they came from. Emitted
 * here rather than written by hand so that adding a block cannot ship artwork
 * with nobody credited: `sources` is required on `Block`.
 */
const cited = [...new Set(faces.flatMap((f) => f.block.sources))].sort();
writeNotices(
  "nerd-font",
  "Terminal icon glyphs",
  `\`src/web/styles/fonts/${FILE_PREFIX}*.woff2\` (${faces.length} files) are subsets of the
symbols-only face from [Nerd Fonts ${VERSION}](${SOURCE_URL}), cut per icon set by
\`scripts/gen-nerd-font.ts\`. Nerd Fonts assembles them from the projects below; the
subsetting reproduces their outlines unchanged.

The \`@font-face\` family is \`${FAMILY}\`, not any upstream family name. That is there so
a local install of the real font is not shadowed, and it also satisfies the Reserved
Font Name clause the SIL OFL sets on Pomicons: no PPM face is offered under a
reserved name.`,
  cited.map((id) => {
    const src = SOURCES[id];
    return {
      name: src.name,
      upstream: src.upstream,
      version: src.version,
      license: src.license,
      holder: src.holder,
    };
  }),
);

const total = faces.reduce((n, f) => n + f.bytes, 0);
const glyphs = faces.reduce((n, f) => n + f.glyphs, 0);
console.log(
  `nerd font  ${faces.length} faces  ${glyphs} glyphs  ${kib(total)} if every block were fetched`,
);
for (const f of [...faces].sort((a, b) => b.bytes - a.bytes)) {
  console.log(`           ${f.block.slug.padEnd(21)} ${String(f.glyphs).padStart(5)} glyphs  ${kib(f.bytes).padStart(9)}`);
}
