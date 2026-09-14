/**
 * The notices file is the only thing standing between PPM's tarball and
 * shipping other people's artwork unattributed, and it is generated — so the
 * failure mode is not a wrong notice, it is a notice nobody regenerated.
 *
 * These read the shipped artefacts and the generators' own source rather than
 * re-running the generators: `gen-nerd-font.ts` downloads 3 MB of font on every
 * run, which is not something a unit test should do.
 */
import { describe, it, expect } from "bun:test";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../../..");
const NOTICES = readFileSync(resolve(ROOT, "THIRD-PARTY-NOTICES.md"), "utf-8");
const GEN_FONT = readFileSync(resolve(ROOT, "scripts/gen-nerd-font.ts"), "utf-8");

/** slug → that entry's source text, taken as the span up to the next entry. */
function blockEntries(): Map<string, string> {
  const body = GEN_FONT.slice(GEN_FONT.indexOf("const BLOCKS"));
  const starts = [...body.matchAll(/slug: "([^"]+)"/g)];
  const out = new Map<string, string>();
  starts.forEach((m, i) => {
    const end = i + 1 < starts.length ? starts[i + 1]!.index! : body.indexOf("\n];");
    out.set(m[1]!, body.slice(m.index!, end));
  });
  return out;
}

describe("THIRD-PARTY-NOTICES.md", () => {
  it("has a section from each of the three generators", () => {
    for (const id of ["product-icons", "file-icons", "nerd-font"]) {
      expect(NOTICES).toContain(`<!-- BEGIN ${id} -->`);
      expect(NOTICES).toContain(`<!-- END ${id} -->`);
    }
  });

  it("names every font file that ships", () => {
    // Every `.woff2` in the tree is somebody else's outlines under a name that
    // says nothing about where they came from, so each icon set has to be in
    // the table. The filenames carry the slug; the table carries the project.
    const fonts = readdirSync(resolve(ROOT, "src/web/styles/fonts"))
      .filter((f) => f.endsWith(".woff2"));
    expect(fonts.length).toBeGreaterThan(0);

    // Each face's slug maps to at least one cited project via the generator's
    // BLOCKS table; assert the generator declares a source for every block.
    // Entries are read as the span from one `slug:` to the next rather than by
    // brace matching — one of them is written across several lines, and a lazy
    // brace match runs straight past it into the block below, which has its own
    // `sources:` and makes the assertion pass for the wrong entry.
    const entries = blockEntries();
    for (const file of fonts) {
      const slug = file.replace(/^nerd-symbols-/, "").replace(/\.woff2$/, "");
      expect(entries.has(slug), `no BLOCKS entry for ${file}`).toBe(true);
      expect(entries.get(slug)!, `${slug} declares no sources`).toContain("sources:");
    }
  });

  it("cites every source the font generator declares", () => {
    const declared = [...GEN_FONT.matchAll(/sources: \[([^\]]+)\]/g)]
      .flatMap((m) => [...m[1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!));
    expect(declared.length).toBeGreaterThan(0);

    const table = NOTICES.slice(NOTICES.indexOf("<!-- BEGIN nerd-font -->"));
    for (const id of new Set(declared)) {
      // SOURCES keys are slugs; the row carries the upstream URL, which is the
      // one field a slug always appears in.
      const src = GEN_FONT.match(new RegExp(`"?${id}"?: \\{[^}]*upstream: "([^"]+)"`));
      expect(src, `no SOURCES entry for "${id}"`).not.toBeNull();
      expect(table, `${id} declared by a block but not in the table`).toContain(src![1]!);
    }
  });

  it("ships the text of every licence it names", () => {
    // MIT, Apache-2.0 and the OFL each require the licence to travel with the
    // work, so a link to spdx.org is not enough — the copy has to be here.
    const linked = [...NOTICES.matchAll(/\(licenses\/([^)]+)\)/g)].map((m) => m[1]!);
    expect(linked.length).toBeGreaterThan(0);
    for (const file of new Set(linked)) {
      const path = resolve(ROOT, "licenses", file);
      expect(existsSync(path), `licenses/${file} is linked but missing`).toBe(true);
      expect(readFileSync(path, "utf-8").length).toBeGreaterThan(500);
    }
  });

  it("gives every row a copyright holder", () => {
    const rows = NOTICES.split("\n").filter((l) => l.startsWith("| ") && !l.startsWith("| ---") && !l.startsWith("| Component"));
    expect(rows.length).toBeGreaterThan(10);
    for (const row of rows) {
      const cells = row.split("|").map((c) => c.trim());
      // name | upstream | version | licence | copyright
      expect(cells.at(-2), `no copyright in: ${row.slice(0, 60)}`).toMatch(/^© \S/);
    }
  });

  it("is pointed at from LICENSE", () => {
    // A notice nothing references is a notice nobody reads.
    expect(readFileSync(resolve(ROOT, "LICENSE"), "utf-8")).toContain("THIRD-PARTY-NOTICES.md");
  });

  it("is not excluded from the published tarball", () => {
    const ignore = readFileSync(resolve(ROOT, ".npmignore"), "utf-8")
      .split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
    for (const pattern of ignore) {
      expect(pattern).not.toBe("THIRD-PARTY-NOTICES.md");
      expect(pattern).not.toBe("licenses/");
      expect(pattern).not.toBe("licenses");
    }
  });
});
