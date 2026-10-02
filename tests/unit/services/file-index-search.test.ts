/**
 * Searching a file list on the server has to rank exactly as the palette ranks a list it holds,
 * or a project would start searching differently the moment it grows past the size that is sent
 * to the browser. The reference here is the palette's own loop (`command-palette.tsx`): every
 * entry scored with `scoreFileSearchFast`, a stable sort, the first `limit`.
 */
import { describe, it, expect } from "bun:test";
import { searchIndex, toSearchable, type SearchKind } from "../../../src/services/file-index/index-search.ts";
import { scoreFileSearchFast, compareScores, getFilename } from "../../../src/web/lib/score-file-search.ts";
import type { FileEntry } from "../../../src/types/project.ts";

function file(path: string): FileEntry {
  return { path, name: path.slice(path.lastIndexOf("/") + 1), type: "file" };
}
function dir(path: string): FileEntry {
  return { path, name: path.slice(path.lastIndexOf("/") + 1), type: "directory" };
}

/** A list with many ties, in walk order: directories before what they hold. */
function fixture(): FileEntry[] {
  const out: FileEntry[] = [file("README.md"), file("index.ts"), dir("src")];
  for (const area of ["app", "components", "lib", "index", "test"]) {
    out.push(dir(`src/${area}`));
    for (let i = 0; i < 40; i++) {
      out.push(file(`src/${area}/${["index", "Button", "button-group", "util", "spec"][i % 5]}${i % 7 === 0 ? "" : i}.${["ts", "tsx", "md"][i % 3]}`));
    }
    out.push(dir(`src/${area}/nested`));
    out.push(file(`src/${area}/nested/deep index.test.ts`));
  }
  out.push(dir("docs"), file("docs/INDEX.md"), file("docs/test spec.md"), file("./odd"));
  return out;
}

/** What the palette would show for `query` if it held `entries` itself. */
function palette(entries: FileEntry[], query: string, kind: SearchKind, limit: number): string[] {
  const candidates = kind === "all" ? entries : entries.filter((e) => e.type === "file");
  if (!query.trim()) return candidates.slice(0, limit).map((e) => e.path);
  const q = query.toLowerCase().replace(/^\.\.?\//, "");
  const scored = [];
  for (const e of candidates) {
    const p = e.path.toLowerCase();
    const s = scoreFileSearchFast(q, getFilename(p), p, e.name.length, e.path.split("/").length);
    if (s) scored.push({ e, s });
  }
  scored.sort((a, b) => compareScores(a.s, b.s));
  return scored.slice(0, limit).map((x) => x.e.path);
}

const paths = (files: FileEntry[]) => files.map((e) => e.path);

describe("searchIndex", () => {
  it("ranks as the palette does at every keystroke, including after backspace", () => {
    const entries = fixture();
    const index = toSearchable(entries);
    for (const typed of ["index.ts", "Button", "src/comp", "comp btn", "Test Spec", "./read", "zz"]) {
      for (let n = 1; n <= typed.length; n++) {
        const q = typed.slice(0, n);
        expect({ q, got: paths(searchIndex(index, q, "file", 25)) }).toEqual({ q, got: palette(entries, q, "file", 25) });
      }
      for (let n = typed.length - 1; n >= 1; n--) {
        const q = typed.slice(0, n);
        expect({ q, got: paths(searchIndex(index, q, "file", 25)) }).toEqual({ q, got: palette(entries, q, "file", 25) });
      }
    }
  });

  it("orders the whole of a tier by score, not only its first entries", () => {
    const entries = fixture();
    // More matches than the limit in the same tier: the heap, not arrival order, decides.
    expect(paths(searchIndex(toSearchable(entries), "i", "file", 7))).toEqual(palette(entries, "i", "file", 7));
    expect(paths(searchIndex(toSearchable(entries), "i", "file", 400))).toEqual(palette(entries, "i", "file", 400));
  });

  it("searches directories too when asked, for the chat's @-picker", () => {
    const entries = fixture();
    const index = toSearchable(entries);
    expect(paths(searchIndex(index, "nest", "all", 10))).toEqual(palette(entries, "nest", "all", 10));
    expect(paths(searchIndex(index, "nest", "all", 10))).toContain("src/app/nested");
    // The same query for files only is its own search, not narrowed from the one above.
    expect(paths(searchIndex(index, "nest", "file", 10))).toEqual(palette(entries, "nest", "file", 10));
    expect(paths(searchIndex(index, "nest", "file", 10))).not.toContain("src/app/nested");
  });

  it("answers a blank query with the first entries in list order", () => {
    const entries = fixture();
    const index = toSearchable(entries);
    expect(paths(searchIndex(index, "  ", "file", 3))).toEqual(["README.md", "index.ts", "src/app/index.ts"]);
    expect(paths(searchIndex(index, "", "all", 3))).toEqual(["README.md", "index.ts", "src"]);
  });

  it("answers nothing for a limit of zero", () => {
    expect(searchIndex(toSearchable(fixture()), "i", "file", 0)).toEqual([]);
  });

  it("looks only at what the query it extends matched", () => {
    const entries = fixture();
    const index = toSearchable(entries);
    searchIndex(index, "spec", "file", 5);
    // An entry "spec" did not match now looks, to the index, like one "specx" would: a search
    // that scanned everything again would find it.
    const planted = entries.findIndex((e) => e.path === "README.md");
    index.pathLower[planted] = "specx";
    index.nameLower[planted] = "specx";
    expect(paths(searchIndex(index, "specx", "file", 5))).not.toContain("README.md");
    // A query that extends nothing recent is a full scan, and does find it.
    expect(paths(searchIndex(index, "pecx", "file", 5))).toContain("README.md");
  });
});
