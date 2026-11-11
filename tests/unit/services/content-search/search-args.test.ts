import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  batchFiles,
  DEFAULT_EXCLUDED_DIRS,
  DEFAULT_EXCLUDED_FILES,
  GREP_ARGV_BUDGET,
  grepArgs,
  planGrepSearch,
  ripgrepArgs,
  toRipgrepGlobs,
  toRipgrepReplacement,
} from "../../../../src/services/content-search/search-args";
import type { SearchRequest } from "../../../../src/services/content-search/search-options";

const rgPath = Bun.which("rg");
const gitPath = Bun.which("git");
const rgHasPcre2 = !!rgPath && Bun.spawnSync([rgPath, "--pcre2-version"]).exitCode === 0;

function req(over: Partial<SearchRequest> = {}): SearchRequest {
  return {
    projectPath: "/p", query: "needle", caseSensitive: false, wholeWord: false, regex: false,
    include: [], exclude: [], useIgnore: true, gzip: false, ...over,
  };
}

/** True when `seq` appears in `args` as consecutive elements. */
function hasSeq(args: string[], ...seq: string[]): boolean {
  for (let i = 0; i + seq.length <= args.length; i++) {
    if (seq.every((s, j) => args[i + j] === s)) return true;
  }
  return false;
}

/** The values of every `-g` flag, in order. */
function globsOf(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length - 1; i++) if (args[i] === "-g") out.push(args[i + 1]!);
  return out;
}

const tmpDirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "ppm-search-args-"));
  tmpDirs.push(dir);
  return dir;
}
afterAll(() => { for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true }); });

function put(root: string, rel: string, text = "needle\n") {
  const path = join(root, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

/** Git with none of the caller's GIT_* variables (a private GIT_INDEX_FILE would point elsewhere). */
function git(cwd: string, ...args: string[]) {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("GIT_") && v !== undefined) env[k] = v;
  const r = Bun.spawnSync([gitPath!, ...args], { cwd, env });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
}

describe("toRipgrepGlobs (VS Code globs → rg)", () => {
  test("a glob with no slash matches at any depth, as a file or as a folder", () => {
    expect(toRipgrepGlobs("*.ts")).toEqual(["**/*.ts", "**/*.ts/**"]);
    expect(toRipgrepGlobs("node_modules")).toEqual(["**/node_modules", "**/node_modules/**"]);
  });
  test("a glob ending in /** stays as it is", () => {
    expect(toRipgrepGlobs("src/**")).toEqual(["src/**"]);
    expect(toRipgrepGlobs("**")).toEqual(["**"]);
  });
  test("a path naming a folder also matches everything under it", () => {
    expect(toRipgrepGlobs("src/foo")).toEqual(["src/foo", "src/foo/**"]);
    expect(toRipgrepGlobs("src/foo/")).toEqual(["src/foo", "src/foo/**"]);
    expect(toRipgrepGlobs("**/*.test.ts")).toEqual(["**/*.test.ts", "**/*.test.ts/**"]);
  });
  test("whitespace, ./ and backslashes are normalised; an empty glob is nothing", () => {
    expect(toRipgrepGlobs("  ./src/foo  ")).toEqual(["src/foo", "src/foo/**"]);
    expect(toRipgrepGlobs("src\\foo")).toEqual(["src/foo", "src/foo/**"]);
    expect(toRipgrepGlobs("   ")).toEqual([]);
    expect(toRipgrepGlobs("")).toEqual([]);
  });
});

describe("toRipgrepReplacement", () => {
  test("a literal replace keeps every $ literal", () => {
    expect(toRipgrepReplacement("a$b$1$$", false)).toBe("a$$b$$1$$$$");
    expect(toRipgrepReplacement("plain", false)).toBe("plain");
  });
  test("a regex replace maps $n, $&, $0 to rg's braced groups and keeps other $ literal", () => {
    expect(toRipgrepReplacement("$1y", true)).toBe("${1}y");
    expect(toRipgrepReplacement("[$&|$0]", true)).toBe("[${0}|${0}]");
    expect(toRipgrepReplacement("$$-$x-$", true)).toBe("$$-$$x-$$");
    expect(toRipgrepReplacement("$123", true)).toBe("${12}3");
  });
});

describe("ripgrepArgs", () => {
  test("always asks for JSON, hidden files, no user config, auto engine and / separators", () => {
    const args = ripgrepArgs(req());
    for (const flag of ["--json", "--hidden", "--no-config", "--engine=auto", "--path-separator=/"]) {
      expect(args).toContain(flag);
    }
  });
  test("the query comes after -- and the search root is the last argument", () => {
    const args = ripgrepArgs(req({ query: "-rf" }));
    expect(args.slice(-3)).toEqual(["--", "-rf", "."]);
  });
  test("literal search uses -F, regex does not", () => {
    expect(ripgrepArgs(req())).toContain("-F");
    expect(ripgrepArgs(req({ regex: true }))).not.toContain("-F");
  });
  test("Match Case off adds -i, on leaves it out", () => {
    expect(ripgrepArgs(req())).toContain("-i");
    expect(ripgrepArgs(req({ caseSensitive: true }))).not.toContain("-i");
  });
  test("Whole Word and Regex combine (3.1)", () => {
    const args = ripgrepArgs(req({ wholeWord: true, regex: true, query: "h.t" }));
    expect(args).toContain("-w");
    expect(args).not.toContain("-F");
  });
  test("-r only when a replace text is set, escaped for literal search", () => {
    expect(ripgrepArgs(req())).not.toContain("-r");
    expect(hasSeq(ripgrepArgs(req({ replace: "a$b" })), "-r", "a$$b")).toBe(true);
    expect(hasSeq(ripgrepArgs(req({ replace: "" })), "-r", "")).toBe(true);
    expect(hasSeq(ripgrepArgs(req({ replace: "<$1>", regex: true })), "-r", "<${1}>")).toBe(true);
  });
  test("ignore files and default excludes on (2.1)", () => {
    const args = ripgrepArgs(req());
    expect(args).not.toContain("--no-ignore");
    const globs = globsOf(args);
    for (const dir of DEFAULT_EXCLUDED_DIRS) expect(globs).toContain(`!${dir}/`);
    for (const file of DEFAULT_EXCLUDED_FILES) expect(globs).toContain(`!${file}`);
    expect(DEFAULT_EXCLUDED_DIRS).toContain("node_modules");
    expect(DEFAULT_EXCLUDED_DIRS).toContain(".git");
  });
  test("ignore files off searches ignored files and the default excluded folders (2.2)", () => {
    const args = ripgrepArgs(req({ useIgnore: false, exclude: ["*.md"] }));
    expect(args).toContain("--no-ignore");
    expect(globsOf(args)).toEqual(["!**/*.md", "!**/*.md/**"]);
  });
  test("includes then excludes, each converted, blanks dropped (2.3, 2.4)", () => {
    const args = ripgrepArgs(req({ useIgnore: false, include: ["*.ts", " src/** ", ""], exclude: ["dist"] }));
    expect(globsOf(args)).toEqual(["**/*.ts", "**/*.ts/**", "src/**", "!**/dist", "!**/dist/**"]);
  });
  test("ignore files on: includes are no -g (it would override them), excludes and defaults are", () => {
    const globs = globsOf(ripgrepArgs(req({ include: ["src"], exclude: ["gen"] })));
    expect(globs.every((g) => g.startsWith("!"))).toBe(true);
    expect(globs).toContain("!node_modules/");
    expect(globs).toContain("!**/gen/**");
  });
  test("search paths follow the query", () => {
    expect(ripgrepArgs(req(), ["lib", "src"]).slice(-4)).toEqual(["--", "needle", "lib", "src"]);
  });
});

/** Files ripgrep reports for `r`, run for real in `root`, as sorted relative paths. */
function rgFiles(root: string, r: SearchRequest): string[] {
  const out = Bun.spawnSync([rgPath!, ...ripgrepArgs(r)], { cwd: root });
  const files = new Set<string>();
  for (const line of out.stdout.toString().split("\n")) {
    if (!line) continue;
    const ev = JSON.parse(line);
    if (ev.type === "match") files.add(String(ev.data.path.text).replace(/^\.\//, ""));
  }
  return [...files].sort();
}

/** Every replacement text rg reports for `r`. */
function rgReplacements(root: string, r: SearchRequest): string[] {
  const out = Bun.spawnSync([rgPath!, ...ripgrepArgs(r)], { cwd: root });
  const texts: string[] = [];
  for (const line of out.stdout.toString().split("\n")) {
    if (!line) continue;
    const ev = JSON.parse(line);
    if (ev.type === "match") for (const s of ev.data.submatches) texts.push(s.replacement?.text);
  }
  return texts;
}

describe.skipIf(!rgPath || !gitPath)("ripgrepArgs against a real ripgrep", () => {
  const root = tmp();
  put(root, "src/a.ts");
  put(root, "src/deep/b.ts");
  put(root, "lib/src/c.ts");
  put(root, "lib/d.md");
  put(root, "out/e.ts");
  put(root, "node_modules/p/f.js");
  put(root, ".hidden/g.ts");
  put(root, "yarn.lock");
  put(root, ".gitignore", "out/\n");
  git(root, "init", "-q");

  test("ignore files on: .gitignore, default folders and lock files are skipped, hidden files are not", () => {
    expect(rgFiles(root, req())).toEqual([".hidden/g.ts", "lib/d.md", "lib/src/c.ts", "src/a.ts", "src/deep/b.ts"]);
  });
  test("ignore files off: everything is searched", () => {
    const files = rgFiles(root, req({ useIgnore: false }));
    for (const f of ["out/e.ts", "node_modules/p/f.js", "yarn.lock", "src/a.ts"]) expect(files).toContain(f);
  });
  // With ignore files on, includes are search paths filtered in runSearch (search-include-ignore.test.ts).
  test("ignore files off: a folder name with no slash includes that folder at any depth", () => {
    expect(rgFiles(root, req({ useIgnore: false, include: ["src"] }))).toEqual(["lib/src/c.ts", "src/a.ts", "src/deep/b.ts"]);
  });
  test("ignore files off: a path with a slash is anchored to the project", () => {
    expect(rgFiles(root, req({ useIgnore: false, include: ["src/deep"] }))).toEqual(["src/deep/b.ts"]);
    expect(rgFiles(root, req({ useIgnore: false, include: ["src/**"] }))).toEqual(["src/a.ts", "src/deep/b.ts"]);
  });
  test("excludes leave matching files and folders out", () => {
    expect(rgFiles(root, req({ exclude: ["*.md", "src"] }))).toEqual([".hidden/g.ts"]);
  });
  test("Whole Word with Regex bounds the regex", () => {
    const w = tmp();
    put(w, "x.txt", "hit\n");
    put(w, "y.txt", "hits\n");
    expect(rgFiles(w, req({ query: "h.t", regex: true, wholeWord: true, useIgnore: false }))).toEqual(["x.txt"]);
  });
  test("replacements come out the way the browser writes them", () => {
    const w = tmp();
    put(w, "x.txt", "abc\n");
    expect(rgReplacements(w, req({ query: "(b)", regex: true, replace: "[$1|$&|$$]", useIgnore: false })))
      .toEqual(["[b|b|$]"]);
    expect(rgReplacements(w, req({ query: "b", replace: "$1$", useIgnore: false }))).toEqual(["$1$"]);
  });
  test.skipIf(!rgHasPcre2)("look-around runs through PCRE2 (3.3)", () => {
    const w = tmp();
    put(w, "x.txt", "hit\n");
    put(w, "y.txt", "hits\n");
    expect(rgFiles(w, req({ query: "hit(?=s)", regex: true, useIgnore: false }))).toEqual(["y.txt"]);
  });
});

describe("grepArgs", () => {
  test("prints file, line and NUL, skips binaries and file errors, ends with -e query --", () => {
    const args = grepArgs(req({ query: "-x" }));
    for (const flag of ["-H", "-n", "--null", "-I", "-s"]) expect(args).toContain(flag);
    expect(args.slice(-3)).toEqual(["-e", "-x", "--"]);
  });
  test("-F for literal, -E for regex, -i, -w", () => {
    expect(grepArgs(req())).toContain("-F");
    expect(grepArgs(req())).toContain("-i");
    const r = grepArgs(req({ regex: true, wholeWord: true, caseSensitive: true }));
    expect(r).toContain("-E");
    expect(r).toContain("-w");
    expect(r).not.toContain("-F");
    expect(r).not.toContain("-i");
  });
});

describe("batchFiles", () => {
  test("keeps every file in order and each batch under the budget", () => {
    const base = ["-n", "-e", "q", "--"];
    const files = Array.from({ length: 200 }, (_, i) => `dir/file-${i}-${"x".repeat(i % 50)}.txt`);
    const batches = batchFiles(base, files, 1024);
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.flat()).toEqual(files);
    const bytes = (list: string[]) => list.reduce((n, a) => n + Buffer.byteLength(a) + 1, 0);
    for (const batch of batches) {
      expect(batch.length).toBeGreaterThan(0);
      expect(bytes(base) + bytes(batch)).toBeLessThanOrEqual(1024);
    }
  });
  test("counts bytes, not characters", () => {
    const files = Array.from({ length: 40 }, (_, i) => `é${i}`.repeat(10));
    for (const batch of batchFiles([], files, 300)) {
      expect(batch.reduce((n, a) => n + Buffer.byteLength(a) + 1, 0)).toBeLessThanOrEqual(300);
    }
  });
  test("a file longer than the budget gets a batch of its own", () => {
    expect(batchFiles([], ["a", "y".repeat(50), "b"], 20)).toEqual([["a"], ["y".repeat(50)], ["b"]]);
  });
  test("no files, no batches; the default budget is 24 KB", () => {
    expect(batchFiles(["-e", "q"], [])).toEqual([]);
    expect(GREP_ARGV_BUDGET).toBe(24 * 1024);
  });
});

describe("planGrepSearch", () => {
  const sorted = (p: { batches: string[][] }) => p.batches.flat().sort();

  test.skipIf(!gitPath)("in a git repo with ignore files on, lists tracked and untracked files git does not ignore", async () => {
    const root = tmp();
    put(root, "src/a.ts");
    put(root, "new.txt");
    put(root, "out/ignored.ts");
    put(root, "node_modules/p/i.js");
    put(root, "bun.lock");
    put(root, ".gitignore", "out/\n");
    git(root, "init", "-q");
    git(root, "add", "src/a.ts");
    const plan = await planGrepSearch(root, req());
    expect(plan.args).toEqual(grepArgs(req()));
    expect(sorted(plan)).toEqual([".gitignore", "new.txt", "src/a.ts"]);
  });

  test.skipIf(!gitPath)("include and exclude filter the git list with VS Code globs", async () => {
    const root = tmp();
    put(root, "src/a.ts");
    put(root, "src/b.md");
    put(root, "lib/src/c.ts");
    put(root, "lib/d.ts");
    git(root, "init", "-q");
    expect(sorted(await planGrepSearch(root, req({ include: ["src"], exclude: ["*.md"] }))))
      .toEqual(["lib/src/c.ts", "src/a.ts"]);
    expect(sorted(await planGrepSearch(root, req({ include: ["src/**"] }))))
      .toEqual(["src/a.ts", "src/b.md"]);
  });

  test("outside git, a walk that prunes the default excluded folders", async () => {
    const root = tmp();
    put(root, "src/a.ts");
    put(root, ".hidden/h.ts");
    put(root, "node_modules/p/i.js");
    put(root, "dist/out.js");
    put(root, "app.min.js");
    expect(sorted(await planGrepSearch(root, req()))).toEqual([".hidden/h.ts", "src/a.ts"]);
  });

  test("ignore files off walks everything, even outside the default excludes", async () => {
    const root = tmp();
    put(root, "src/a.ts");
    put(root, "node_modules/p/i.js");
    put(root, "app.min.js");
    put(root, "out/x.ts");
    put(root, ".gitignore", "out/\n");
    if (gitPath) git(root, "init", "-q");
    const files = sorted(await planGrepSearch(root, req({ useIgnore: false, exclude: ["*.md"] })));
    for (const f of ["src/a.ts", "node_modules/p/i.js", "app.min.js", "out/x.ts", ".gitignore"]) expect(files).toContain(f);
  });

  test("the walk applies include and exclude too", async () => {
    const root = tmp();
    put(root, "src/a.ts");
    put(root, "src/gen/b.ts");
    put(root, "docs/c.ts");
    expect(sorted(await planGrepSearch(root, req({ include: ["*.ts"], exclude: ["gen"] }))))
      .toEqual(["docs/c.ts", "src/a.ts"]);
  });

  test("batches stay under the argv budget", async () => {
    const root = tmp();
    for (let i = 0; i < 400; i++) put(root, `d/${"n".repeat(80)}-${i}.txt`);
    const plan = await planGrepSearch(root, req());
    expect(plan.batches.length).toBeGreaterThan(1);
    expect(plan.batches.flat().length).toBe(400);
    const bytes = (list: string[]) => list.reduce((n, a) => n + Buffer.byteLength(a) + 1, 0);
    for (const batch of plan.batches) expect(bytes(plan.args) + bytes(batch)).toBeLessThanOrEqual(GREP_ARGV_BUDGET);
  });
});
