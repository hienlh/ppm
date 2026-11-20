/**
 * Which strings in an AI answer are folder or file paths worth checking. Every hit costs a check
 * on the server, and a sentence is full of slashes that are not paths, so the misses matter as
 * much as the hits: URLs, "and/or", fractions, dates and ratios must never be candidates.
 */
import { describe, expect, it } from "bun:test";
import { findPathsInText, inlineCodePath, looksLikeLocalPath } from "../../../src/web/lib/local-path-detect";

const paths = (text: string) => findPathsInText(text).map((h) => h.path);

describe("findPathsInText", () => {
  it("finds absolute Windows, home and POSIX paths in prose", () => {
    expect(paths("Saved in D:\\tiktok\\story-2026-11-19-london today")).toEqual(["D:\\tiktok\\story-2026-11-19-london"]);
    expect(paths("Look in C:/Users/PC/Projects.")).toEqual(["C:/Users/PC/Projects"]);
    expect(paths("Open ~/Projects/ppm, then run it")).toEqual(["~/Projects/ppm"]);
    expect(paths("Logs are in /var/log/ppm.")).toEqual(["/var/log/ppm"]);
  });

  it("finds a relative path with an extension, a trailing separator or two separators", () => {
    expect(paths("Edited src/web/app.tsx and docs/ plus src/web/components")).toEqual(["src/web/app.tsx", "docs/", "src/web/components"]);
  });

  it("keeps a line suffix apart from the path", () => {
    const [hit] = findPathsInText("see src/server/index.ts:42 for it");
    expect(hit).toMatchObject({ path: "src/server/index.ts", line: { start: 42 } });
    expect("see src/server/index.ts:42 for it".slice(hit!.start, hit!.end)).toBe("src/server/index.ts:42");
  });

  it("drops brackets and sentence punctuation around a path", () => {
    expect(paths("(see D:\\Projects\\app), and \"~/notes/today.md\"; done")).toEqual(["D:\\Projects\\app", "~/notes/today.md"]);
  });

  it("never takes URLs, fractions, dates, ratios or a/b words", () => {
    for (const text of [
      "Visit https://example.com/a/b/c.html now",
      "www.example.com/docs/page",
      "Use it and/or that, a/b, TCP/IP, I/O, w/o, km/h",
      "Half is 1/2 and 50/50; ratio 16/9",
      "Due 20/11/2026 or 2026/11/20",
      "A/B testing",
      "localhost:3000/api/users",
      "//cdn.example.com/x.js",
    ]) expect(paths(text)).toEqual([]);
  });

  it("does not take a lone POSIX word with a slash in front", () => {
    expect(paths("run it as /usr only")).toEqual([]);
    expect(paths("open /README.md")).toEqual(["/README.md"]);
  });
});

describe("inlineCodePath", () => {
  it("takes a quoted path whole, spaces included", () => {
    expect(inlineCodePath("C:\\Program Files\\PPM")).toEqual({ path: "C:\\Program Files\\PPM" });
    expect(inlineCodePath("src/web")).toEqual({ path: "src/web" });
    expect(inlineCodePath("D:\\")).toEqual({ path: "D:\\" });
    expect(inlineCodePath("src/app.ts:10-20")).toEqual({ path: "src/app.ts", line: { start: 10, end: 20 } });
  });

  it("leaves code that is not a path", () => {
    for (const text of ["npm run build", "1/2", "16/9", "https://x.dev/a/b", "foo.ts", "x => y / 2", "*.ts/**"]) {
      expect(inlineCodePath(text)).toBeNull();
    }
  });
});

describe("looksLikeLocalPath", () => {
  it("refuses UNC shares and control characters", () => {
    expect(looksLikeLocalPath("\\\\server\\share\\x", true)).toBe(false);
    expect(looksLikeLocalPath("C:\\a\u0007b", true)).toBe(false);
  });
});
