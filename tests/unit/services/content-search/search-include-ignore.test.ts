/**
 * "Files to include" must not bring back files the ignore rules leave out. ripgrep's `-g` always
 * overrides ignore files, so while "Use Exclude Settings and Ignore Files" is on an include is a
 * search path (its literal folder prefix) plus a filter in `runSearch`, never a `-g`.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { includeSearchPaths, ripgrepArgs } from "../../../../src/services/content-search/search-args";
import type { SearchRequest } from "../../../../src/services/content-search/search-options";
import { runSearch } from "../../../../src/services/content-search/search-run";

const RG = Bun.which("rg");
const GIT = Bun.which("git");

const dirs: string[] = [];
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "ppm-include-ignore-"));
  dirs.push(root);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

function git(cwd: string, ...args: string[]) {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("GIT_") && v !== undefined) env[k] = v;
  const r = Bun.spawnSync([GIT!, ...args], { cwd, env });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
}

function req(over: Partial<SearchRequest> = {}): SearchRequest {
  return {
    projectPath: "/p", query: "needle", caseSensitive: false, wholeWord: false, regex: false,
    include: [], exclude: [], useIgnore: true, gzip: false, ...over,
  };
}

function globsOf(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length - 1; i++) if (args[i] === "-g") out.push(args[i + 1]!);
  return out;
}

describe("ripgrepArgs with includes", () => {
  test("ignore files on: no include reaches rg as -g, only exclusions do", () => {
    const args = ripgrepArgs(req({ include: ["src", "*.ts", "lib/**"], exclude: ["gen"] }));
    expect(globsOf(args).filter((g) => !g.startsWith("!"))).toEqual([]);
    expect(globsOf(args)).toContain("!**/gen/**");
  });
  test("the search paths follow the query; with none given, the project root", () => {
    expect(ripgrepArgs(req({ query: "-x" })).slice(-3)).toEqual(["--", "-x", "."]);
    expect(ripgrepArgs(req({ include: ["src/**", "lib/**"] }), ["lib", "src"]).slice(-4))
      .toEqual(["--", "needle", "lib", "src"]);
  });
  test("ignore files off: includes still go to rg as -g", () => {
    expect(globsOf(ripgrepArgs(req({ useIgnore: false, include: ["*.ts"] })))).toEqual(["**/*.ts", "**/*.ts/**"]);
  });
});

describe("includeSearchPaths", () => {
  const root = project({
    "src/server/x.ts": "", "src/web/y.ts": "", "lib/z.ts": "", "README.md": "",
  });

  test("no includes, or one with no literal folder, searches the whole project", () => {
    expect(includeSearchPaths(root, [])).toEqual(["."]);
    expect(includeSearchPaths(root, ["*.ts"])).toEqual(["."]);
    expect(includeSearchPaths(root, ["src"])).toEqual(["."]);
    expect(includeSearchPaths(root, ["src/server/**", "**/*.md"])).toEqual(["."]);
  });
  test("a path's literal folder prefix becomes the search path", () => {
    expect(includeSearchPaths(root, ["src/server/**"])).toEqual(["src/server"]);
    expect(includeSearchPaths(root, ["src/server"])).toEqual(["src"]);
    expect(includeSearchPaths(root, ["src/*/x.ts"])).toEqual(["src"]);
    expect(includeSearchPaths(root, ["./src/web/", "lib/*.ts"])).toEqual(["lib", "src/web"]);
  });
  test("a file named outright is never a search path (rg searches a named file even when ignored)", () => {
    expect(includeSearchPaths(root, ["src/server/x.ts"])).toEqual(["src/server"]);
    expect(includeSearchPaths(root, ["README.md/**"])).toEqual([]);
  });
  test("nested prefixes collapse into one", () => {
    expect(includeSearchPaths(root, ["src/server/**", "src/**", "src/web/**"])).toEqual(["src"]);
  });
  test("paths that do not exist are dropped; none left means nothing to search", () => {
    expect(includeSearchPaths(root, ["nope/**", "src/web/**"])).toEqual(["src/web"]);
    expect(includeSearchPaths(root, ["nope/**"])).toEqual([]);
  });
  test("a prefix outside the project is dropped", () => {
    expect(includeSearchPaths(root, ["../src/**"])).toEqual([]);
    expect(includeSearchPaths(root, ["src/../../x/**"])).toEqual([]);
    expect(includeSearchPaths(root, [`${root}/src/**`])).toEqual([]);
  });
});

describe.skipIf(!RG || !GIT)("runSearch: includes with .gitignore (2.1, 2.4)", () => {
  const root = project({
    ".gitignore": "src/server/\n",
    "src/server/y.ts": "needle\n",
    "src/a.ts": "needle\n",
    "src/a.md": "needle\n",
    "lib/b.ts": "needle\nneedle\nneedle\n",
    "lib/src/c.ts": "needle\n",
  });
  git(root, "init", "-q");
  const tool = async () => ({ kind: "rg" as const, path: RG! });
  const files = async (over: Partial<SearchRequest>, maxMatches?: number) =>
    (await runSearch(root, req({ projectPath: root, ...over }), undefined, { resolveTool: tool, maxMatches }))
      .results.map((r) => r.file);

  test("a folder include keeps the ignored folder out", async () => {
    expect(await files({ include: ["src"] })).toEqual(["lib/src/c.ts", "src/a.md", "src/a.ts"]);
    expect(await files({ include: ["src/**"] })).toEqual(["src/a.md", "src/a.ts"]);
  });
  test("an extension include keeps ignored files out", async () => {
    expect(await files({ include: ["*.ts"] })).toEqual(["lib/b.ts", "lib/src/c.ts", "src/a.ts"]);
  });
  test("an include naming the ignored folder or file finds nothing", async () => {
    expect(await files({ include: ["src/server/**"] })).toEqual([]);
    expect(await files({ include: ["src/server/y.ts"] })).toEqual([]);
  });
  test("an include of a folder that does not exist is an empty answer, not an error", async () => {
    expect(await files({ include: ["nope/**"] })).toEqual([]);
    expect(await files({ include: ["nope/**", "lib/**"] })).toEqual(["lib/b.ts", "lib/src/c.ts"]);
  });
  test("files the include leaves out do not count toward the match limit", async () => {
    const res = await runSearch(root, req({ projectPath: root, include: ["*.md"] }), undefined,
      { resolveTool: tool, maxMatches: 1 });
    expect(res.results.map((r) => r.file)).toEqual(["src/a.md"]);
    expect(res.total).toBe(1);
    expect(res.limitHit).toBe(false);
  });
  test("excludes still apply beside an include", async () => {
    expect(await files({ include: ["*.ts"], exclude: ["lib/src"] })).toEqual(["lib/b.ts", "src/a.ts"]);
  });
  test("ignore files off: the include finds the ignored folder too", async () => {
    expect(await files({ include: ["src/**"], useIgnore: false })).toEqual(["src/a.md", "src/a.ts", "src/server/y.ts"]);
  });
});
