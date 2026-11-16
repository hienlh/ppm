import { describe, expect, test } from "bun:test";
import {
  isPathQuery,
  normalizePathQuery,
  pathListingEntries,
  pathQueryDir,
  pathQueryFileFilter,
  pathQueryIntoFolder,
  rankPathEntries,
  relativeToDir,
  type PathListing,
} from "../../../src/web/lib/path-query-matches";

/** A folder like the one in the report: every name begins with the same 13 characters. */
const EVIDENCE = "C:\\Users\\PC\\.agents\\skills\\nxsys-e2e-test\\evidence\\NX-6641";
const NAMES = [
  "NX-6641-fail-existing-nx6618-summary-261116.png",
  "NX-6641-pass-ie-manual-draft-result-261116.png",
  "NX-6641-pass-ie-manual-generate-261116.png",
  "NX-6641-pass-uk-dashboard-261116.png",
];
const listing: PathListing = {
  dir: EVIDENCE,
  dirs: [`${EVIDENCE}\\raw`],
  files: [...NAMES.map((n) => `${EVIDENCE}\\${n}`), `${EVIDENCE}\\raw\\NX-6641-pass-uk-dashboard-261116.webm`],
};
const entries = pathListingEntries(listing);

/** What a query lists, as the names the rows show (with their subfolder). */
function rows(query: string): string[] {
  return rankPathEntries(entries, pathQueryFileFilter(normalizePathQuery(query))).map((e) => `${e.relDir}${e.name}`);
}

describe("pathQueryFileFilter", () => {
  test("takes the name after a Windows separator", () => {
    expect(pathQueryFileFilter("D:\\tiktok\\out\\uk-journey-with-song.mp4")).toBe("uk-journey-with-song.mp4");
  });

  test("takes the name after a POSIX separator, lowercased", () => {
    expect(pathQueryFileFilter("~/Projects/README")).toBe("readme");
  });

  test("is empty while the query ends at a directory", () => {
    expect(pathQueryFileFilter("D:\\tiktok\\out\\")).toBe("");
    expect(pathQueryFileFilter("/usr/local/")).toBe("");
  });
});

describe("pathQueryDir", () => {
  test("keeps everything up to the last separator of either kind", () => {
    expect(pathQueryDir(`${EVIDENCE}\\${NAMES[1]}`)).toBe(`${EVIDENCE}\\`);
    expect(pathQueryDir("C:/Users/PC/x/y.png")).toBe("C:/Users/PC/x/");
    expect(pathQueryDir("C:\\Users/PC\\x")).toBe("C:\\Users/PC\\");
  });

  test("a name typed at the root browses the root, not a folder of that name", () => {
    expect(pathQueryDir("/us")).toBe("/");
    expect(pathQueryDir("~/Proj")).toBe("~/");
  });
});

describe("an exact file", () => {
  test("a full Windows path with \\ lists that file alone, not the whole folder", () => {
    expect(rows(`${EVIDENCE}\\NX-6641-pass-ie-manual-generate-261116.png`))
      .toEqual(["NX-6641-pass-ie-manual-generate-261116.png"]);
  });

  test("the same path written with / does too", () => {
    expect(rows("C:/Users/PC/.agents/skills/nxsys-e2e-test/evidence/NX-6641/NX-6641-pass-uk-dashboard-261116.png"))
      .toEqual(["NX-6641-pass-uk-dashboard-261116.png"]);
  });

  test("matches whatever case the name was typed in", () => {
    expect(rows(`${EVIDENCE}\\nx-6641-PASS-uk-dashboard-261116.PNG`)).toEqual(["NX-6641-pass-uk-dashboard-261116.png"]);
  });

  test("the exact name comes first, ahead of longer names that start with it", () => {
    const close: PathListing = {
      dir: "/d", dirs: [],
      files: ["/d/song.mp4.bak", "/d/my-song.mp4", "/d/song.mp4x", "/d/song.mp4", "/d/a-song.mp4-old"],
    };
    const ranked = rankPathEntries(pathListingEntries(close), pathQueryFileFilter("/d/song.mp4")).map((e) => e.name);
    expect(ranked).toEqual(["song.mp4", "song.mp4x", "song.mp4.bak", "my-song.mp4", "a-song.mp4-old"]);
  });

  test("among names starting with the query, the shallower entry comes first", () => {
    expect(rows(`${EVIDENCE}\\NX-6641-pass-uk-dashboard-261116`)).toEqual([
      "NX-6641-pass-uk-dashboard-261116.png",
      "raw/NX-6641-pass-uk-dashboard-261116.webm",
    ]);
  });
});

describe("a folder", () => {
  test("with a trailing \\ lists its own entries, folders first, nothing from below", () => {
    expect(rows(`${EVIDENCE}\\`)).toEqual(["raw", ...NAMES]);
  });

  test("lists its own entries by name whatever order the host read them in", () => {
    const shuffled: PathListing = {
      dir: "/d", dirs: ["/d/b-dir", "/d/A-dir"],
      files: ["/d/shot-10.png", "/d/Shot-2.png", "/d/notes.md", "/d/sub/deep.png"],
    };
    expect(rankPathEntries(pathListingEntries(shuffled), "").map((e) => e.name))
      .toEqual(["A-dir", "b-dir", "notes.md", "Shot-2.png", "shot-10.png"]);
  });

  test("with a trailing / lists the same", () => {
    expect(rows("C:/Users/PC/.agents/skills/nxsys-e2e-test/evidence/NX-6641/")).toEqual(["raw", ...NAMES]);
  });

  test("without its trailing separator lists the folder and then what is inside it", () => {
    const outer: PathListing = {
      dir: "C:\\work\\evidence",
      dirs: ["C:\\work\\evidence\\NX-6641"],
      files: ["C:\\work\\evidence\\notes.txt", "C:\\work\\evidence\\NX-6641\\shot.png", "C:\\work\\evidence\\NX-6641\\NX-6641-a.png"],
    };
    const ranked = rankPathEntries(pathListingEntries(outer), pathQueryFileFilter("C:\\work\\evidence\\NX-6641"));
    expect(ranked.map((e) => `${e.kind}:${e.relDir}${e.name}`)).toEqual([
      "folder:NX-6641",
      // shot.png does not carry the folder's name, and is listed all the same
      "file:NX-6641/shot.png",
      "file:NX-6641/NX-6641-a.png",
    ]);
  });

  test("stepping into a folder keeps the separator the query was written with", () => {
    expect(pathQueryIntoFolder(`${EVIDENCE}\\ra`, "raw")).toBe(`${EVIDENCE}\\raw\\`);
    expect(pathQueryIntoFolder("~/Projects/p", "ppm")).toBe("~/Projects/ppm/");
  });
});

describe("names sharing a long prefix", () => {
  test("each row carries its whole name and only the folder below the listed one", () => {
    const file = entries.find((e) => e.name.endsWith(".webm"))!;
    expect(file).toMatchObject({ kind: "file", relDir: "raw/", path: `${EVIDENCE}\\raw\\${file.name}` });
    for (const e of entries.filter((x) => x.kind === "file" && !x.relDir)) {
      expect(NAMES).toContain(e.name);
      expect(e.path).toBe(`${EVIDENCE}\\${e.name}`);
    }
  });

  test("typing past the shared prefix narrows to the names that differ there", () => {
    expect(rows(`${EVIDENCE}\\NX-6641-pass-ie-manual-`)).toEqual([
      "NX-6641-pass-ie-manual-generate-261116.png",
      "NX-6641-pass-ie-manual-draft-result-261116.png",
    ]);
  });

  test("a part from the middle of the name finds it", () => {
    expect(rows(`${EVIDENCE}\\draft`)).toEqual(["NX-6641-pass-ie-manual-draft-result-261116.png"]);
  });
});

describe("relativeToDir", () => {
  test("is separator- and case-blind, and tolerates a trailing separator on the directory", () => {
    expect(relativeToDir("C:\\A\\b\\", "c:/a/B/sub/x.png")).toBe("sub/x.png");
    expect(relativeToDir("/home/u", "/home/u/x")).toBe("x");
    expect(relativeToDir("C:\\", "C:\\x.txt")).toBe("x.txt");
  });

  test("falls back to the name for a path outside the directory", () => {
    expect(relativeToDir("/home/u", "/home/user2/x")).toBe("x");
  });
});

describe("normalizePathQuery", () => {
  test("strips the quotes of Windows' Copy as path", () => {
    expect(normalizePathQuery(`"${EVIDENCE}\\${NAMES[0]}"`)).toBe(`${EVIDENCE}\\${NAMES[0]}`);
  });

  test("strips backticks and surrounding whitespace", () => {
    expect(normalizePathQuery("  `/home/u/a b.txt`\n")).toBe("/home/u/a b.txt");
  });

  test("turns a file URL into the path it names", () => {
    expect(normalizePathQuery("file:///C:/Users/PC/My%20Shots/a.png")).toBe("C:/Users/PC/My Shots/a.png");
    expect(normalizePathQuery("file:///home/u/x.md")).toBe("/home/u/x.md");
  });

  test("leaves text that is not a path alone", () => {
    expect(normalizePathQuery('"open settings"')).toBe('"open settings"');
    expect(normalizePathQuery("src/app.ts")).toBe("src/app.ts");
    expect(isPathQuery(normalizePathQuery("src/app.ts"))).toBe(false);
  });
});
