import { describe, expect, test } from "bun:test";
import { pathQueryFileFilter, rankPathQueryMatches } from "../../../src/web/lib/path-query-matches";

const FOLDER = ["check-swap.jpg", "frame-grid.jpg", "uk-journey-silent.mp4", "uk-journey-with-song.mp4"];
const byName = (s: string) => s;

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

describe("rankPathQueryMatches", () => {
  test("a full Windows path lists that file alone, not the whole folder", () => {
    const filter = pathQueryFileFilter("D:\\tiktok\\uk-journey-2026-10-15\\out\\uk-journey-with-song.mp4");
    expect(rankPathQueryMatches(FOLDER, filter, byName)).toEqual(["uk-journey-with-song.mp4"]);
  });

  test("exact name first, then prefix, then contains, shorter first within a tier", () => {
    const items = ["my-song.mp4", "song.mp4.bak", "song.mp4", "a-song.mp4-old", "song.mp4x"];
    expect(rankPathQueryMatches(items, "song.mp4", byName)).toEqual([
      "song.mp4", "song.mp4x", "song.mp4.bak", "my-song.mp4", "a-song.mp4-old",
    ]);
  });

  test("matches case-insensitively", () => {
    expect(rankPathQueryMatches(["Readme.MD", "notes.md"], "readme", byName)).toEqual(["Readme.MD"]);
  });

  test("an empty filter keeps every entry in listing order", () => {
    expect(rankPathQueryMatches(FOLDER, "", byName)).toEqual(FOLDER);
  });
});
