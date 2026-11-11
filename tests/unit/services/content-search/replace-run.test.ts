import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { runReplace } from "../../../../src/services/content-search/replace-run.ts";
import type { ReplaceMatch } from "../../../../src/services/content-search/search-options.ts";
import { getPpmDir } from "../../../../src/services/ppm-dir.ts";

let root: string;
let project: string;
let outside: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ppm-replace-run-"));
  project = join(root, "project");
  outside = join(root, "outside");
  mkdirSync(project);
  mkdirSync(outside);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function put(rel: string, content: string | Buffer, dir = project): string {
  const path = join(dir, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

const read = (rel: string, dir = project) => readFileSync(join(dir, rel), "utf8");

const m = (line: number, column: number, text: string, replacement: string): ReplaceMatch => ({
  line,
  column,
  text,
  replacement,
});

describe("runReplace: changes exactly the listed matches", () => {
  test("replaces several matches on one line and on several lines, from the end", async () => {
    put("a.ts", "foo bar foo\nfoo\nnothing\n");
    const report = await runReplace(project, {
      projectPath: project,
      files: [{ file: "a.ts", matches: [m(1, 0, "foo", "longer"), m(1, 8, "foo", "x"), m(2, 0, "foo", "")] }],
    });
    expect(read("a.ts")).toBe("longer bar x\n\nnothing\n");
    expect(report).toEqual({ replaced: 3, files: 1, skipped: [], failed: [] });
  });

  test("leaves matches that were not listed (dismissed) alone", async () => {
    put("a.ts", "foo foo foo\n");
    const report = await runReplace(project, {
      projectPath: project,
      files: [{ file: "a.ts", matches: [m(1, 4, "foo", "BAR")] }],
    });
    expect(read("a.ts")).toBe("foo BAR foo\n");
    expect(report.replaced).toBe(1);
  });

  test("matches listed out of order are applied correctly", async () => {
    put("a.ts", "ab\ncd ab\nab\n");
    await runReplace(project, {
      projectPath: project,
      files: [{ file: "a.ts", matches: [m(3, 0, "ab", "3"), m(1, 0, "ab", "1"), m(2, 3, "ab", "2")] }],
    });
    expect(read("a.ts")).toBe("1\ncd 2\n3\n");
  });

  test("writes the replacement as given ($1 already expanded by the engine, a literal $ stays literal)", async () => {
    put("a.ts", "let x = foo(1);\n");
    await runReplace(project, {
      projectPath: project,
      files: [{ file: "a.ts", matches: [m(1, 8, "foo(1)", "bar(1, $1)")] }],
    });
    expect(read("a.ts")).toBe("let x = bar(1, $1);\n");
  });

  test("columns are UTF-16 units after é and an emoji", async () => {
    put("a.ts", "é😀x y x\n");
    await runReplace(project, {
      projectPath: project,
      files: [{ file: "a.ts", matches: [m(1, 3, "x", "Z"), m(1, 7, "x", "W")] }],
    });
    expect(read("a.ts")).toBe("é😀Z y W\n");
  });

  test("keeps CRLF line endings and a file with no final newline", async () => {
    put("a.ts", "foo\r\nbar foo");
    await runReplace(project, {
      projectPath: project,
      files: [{ file: "a.ts", matches: [m(1, 0, "foo", "a"), m(2, 4, "foo", "b")] }],
    });
    expect(read("a.ts")).toBe("a\r\nbar b");
  });

  test("keeps a UTF-8 BOM, with line 1's columns counted after it as ripgrep reports them", async () => {
    put("a.ts", "﻿ab foo\nfoo\n");
    const report = await runReplace(project, {
      projectPath: project,
      files: [{ file: "a.ts", matches: [m(1, 3, "foo", "X"), m(2, 0, "foo", "Y")] }],
    });
    expect(report.skipped).toEqual([]);
    expect(readFileSync(join(project, "a.ts"))).toEqual(Buffer.from("﻿ab X\nY\n"));
  });

  test("nested paths with / are resolved inside the project", async () => {
    put("src/deep/b.ts", "old\n");
    const report = await runReplace(project, {
      projectPath: project,
      files: [{ file: "src/deep/b.ts", matches: [m(1, 0, "old", "new")] }],
    });
    expect(read("src/deep/b.ts")).toBe("new\n");
    expect(report.files).toBe(1);
  });

  test("keeps the file's permission bits", async () => {
    if (process.platform === "win32") return;
    const path = put("run.sh", "echo foo\n");
    chmodSync(path, 0o755);
    await runReplace(project, { projectPath: project, files: [{ file: "run.sh", matches: [m(1, 5, "foo", "bar")] }] });
    const { statSync } = await import("node:fs");
    expect(statSync(path).mode & 0o777).toBe(0o755);
  });
});

describe("runReplace: a file changed since the search is skipped whole", () => {
  test("a match whose text moved skips the file, and none of its matches are written", async () => {
    put("a.ts", "foo\n// inserted\nfoo\n");
    const report = await runReplace(project, {
      projectPath: project,
      files: [{ file: "a.ts", matches: [m(1, 0, "foo", "X"), m(2, 0, "foo", "Y")] }],
    });
    expect(read("a.ts")).toBe("foo\n// inserted\nfoo\n");
    expect(report).toEqual({ replaced: 0, files: 0, skipped: [{ file: "a.ts", reason: "changed" }], failed: [] });
  });

  test("a line past the end of the file counts as changed", async () => {
    put("a.ts", "foo\n");
    const report = await runReplace(project, {
      projectPath: project,
      files: [{ file: "a.ts", matches: [m(5, 0, "foo", "X")] }],
    });
    expect(report.skipped).toEqual([{ file: "a.ts", reason: "changed" }]);
    expect(read("a.ts")).toBe("foo\n");
  });

  test("a match that would run past its line's end counts as changed", async () => {
    put("a.ts", "fo\no\n");
    const report = await runReplace(project, {
      projectPath: project,
      files: [{ file: "a.ts", matches: [m(1, 0, "fo\no", "X")] }],
    });
    expect(report.skipped).toEqual([{ file: "a.ts", reason: "changed" }]);
    expect(read("a.ts")).toBe("fo\no\n");
  });

  test("other files are still replaced", async () => {
    put("a.ts", "bar\n");
    put("b.ts", "foo\n");
    const report = await runReplace(project, {
      projectPath: project,
      files: [
        { file: "a.ts", matches: [m(1, 0, "foo", "X")] },
        { file: "b.ts", matches: [m(1, 0, "foo", "X")] },
      ],
    });
    expect(read("b.ts")).toBe("X\n");
    expect(report).toEqual({ replaced: 1, files: 1, skipped: [{ file: "a.ts", reason: "changed" }], failed: [] });
  });
});

describe("runReplace: refused and failed files are reported, the rest replaced", () => {
  async function failedReason(file: string): Promise<string | undefined> {
    const report = await runReplace(project, {
      projectPath: project,
      files: [
        { file, matches: [m(1, 0, "foo", "X")] },
        { file: "ok.ts", matches: [m(1, 0, "foo", "X")] },
      ],
    });
    expect(read("ok.ts")).toBe("X\n");
    expect(report.replaced).toBe(1);
    expect(report.files).toBe(1);
    expect(report.skipped).toEqual([]);
    expect(report.failed.map((f) => f.file)).toEqual([file]);
    return report.failed[0]?.reason;
  }

  beforeEach(() => {
    put("ok.ts", "foo\n");
  });

  test("a path climbing out of the project", async () => {
    put("victim.ts", "foo\n", outside);
    expect(await failedReason("../outside/victim.ts")).toBeTruthy();
    expect(read("victim.ts", outside)).toBe("foo\n");
  });

  test("an absolute path outside the project", async () => {
    const victim = put("victim.ts", "foo\n", outside);
    expect(await failedReason(victim)).toBeTruthy();
    expect(read("victim.ts", outside)).toBe("foo\n");
  });

  test("a symlink inside the project pointing outside it", async () => {
    if (process.platform === "win32") return;
    const victim = put("victim.ts", "foo\n", outside);
    symlinkSync(victim, join(project, "link.ts"));
    expect(await failedReason("link.ts")).toBeTruthy();
    expect(read("victim.ts", outside)).toBe("foo\n");
  });

  test("a symlinked folder inside the project pointing outside it", async () => {
    if (process.platform === "win32") return;
    put("victim.ts", "foo\n", outside);
    symlinkSync(outside, join(project, "dir"));
    expect(await failedReason("dir/victim.ts")).toBeTruthy();
    expect(read("victim.ts", outside)).toBe("foo\n");
  });

  test("anything under .git", async () => {
    put(".git/config", "foo\n");
    expect(await failedReason(".git/config")).toBeTruthy();
    expect(read(".git/config")).toBe("foo\n");
  });

  test("anything under node_modules", async () => {
    put("node_modules/pkg/index.js", "foo\n");
    expect(await failedReason("node_modules/pkg/index.js")).toBeTruthy();
    expect(read("node_modules/pkg/index.js")).toBe("foo\n");
  });

  test("a file that does not exist", async () => {
    expect(await failedReason("missing.ts")).toBeTruthy();
  });

  test("a file that is not UTF-8 text is never rewritten", async () => {
    const bytes = Buffer.from([0x66, 0x6f, 0x6f, 0x20, 0xff, 0xfe, 0x0a]);
    put("bin.dat", bytes);
    expect(await failedReason("bin.dat")).toBeTruthy();
    expect(readFileSync(join(project, "bin.dat"))).toEqual(bytes);
  });

  test("a write error", async () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    const path = put("ro.ts", "foo\n");
    chmodSync(path, 0o444);
    expect(await failedReason("ro.ts")).toBeTruthy();
    expect(read("ro.ts")).toBe("foo\n");
  });

  test("a credential path (the PPM directory) inside the project", async () => {
    // The test PPM_HOME is a temp dir; a project at its parent contains it.
    const ppmDir = getPpmDir();
    const secret = join(ppmDir, "replace-run-secret.txt");
    writeFileSync(secret, "foo\n");
    try {
      const report = await runReplace(dirname(ppmDir), {
        projectPath: dirname(ppmDir),
        files: [{ file: `${basename(ppmDir)}/replace-run-secret.txt`, matches: [m(1, 0, "foo", "X")] }],
      });
      expect(report.replaced).toBe(0);
      expect(report.failed.map((f) => f.file)).toEqual([`${basename(ppmDir)}/replace-run-secret.txt`]);
      expect(readFileSync(secret, "utf8")).toBe("foo\n");
    } finally {
      rmSync(secret, { force: true });
    }
  });
});

describe("runReplace: the report", () => {
  test("an empty request reports nothing", async () => {
    expect(await runReplace(project, { projectPath: project, files: [] })).toEqual({
      replaced: 0,
      files: 0,
      skipped: [],
      failed: [],
    });
  });

  test("counts matches and files across several files", async () => {
    put("a.ts", "foo foo\n");
    put("b.ts", "foo\n");
    const report = await runReplace(project, {
      projectPath: project,
      files: [
        { file: "a.ts", matches: [m(1, 0, "foo", "x"), m(1, 4, "foo", "y")] },
        { file: "b.ts", matches: [m(1, 0, "foo", "z")] },
      ],
    });
    expect(report).toEqual({ replaced: 3, files: 2, skipped: [], failed: [] });
    expect(read("a.ts")).toBe("x y\n");
    expect(read("b.ts")).toBe("z\n");
  });
});
