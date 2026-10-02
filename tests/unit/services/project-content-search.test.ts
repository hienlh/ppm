import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveProjectSearchGrep, resolveProjectSearchTool, searchProjectContent, type ProjectSearchOptions } from "../../../src/services/project-content-search.service";

let root: string;
let parityRoot: string;

// Every search test runs against each tool this machine has: ripgrep is preferred, grep is the fallback.
const rgPath = Bun.which("rg");
const grepPath = await resolveProjectSearchGrep();
const tools = [
  ...(rgPath ? [{ kind: "rg" as const, path: rgPath }] : []),
  ...(grepPath ? [{ kind: "grep" as const, path: grepPath }] : []),
];

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "ppm-content-search-"));
  await mkdir(join(root, "src"));
  await mkdir(join(root, "node_modules"));
  await writeFile(join(root, "src", "hello world.txt"), "Hello world\nhello worlds\nHELLO\nhello\nhello\nhello\nhello\n");
  await writeFile(join(root, "src", "ti\u1ebfng Vi\u1ec7t.ts"), "hello: Unicode\nprice $2.00\n");
  await writeFile(join(root, "node_modules", "hidden.txt"), "hello");
  await writeFile(join(root, "hidden.min.js"), "hello");
  if (process.platform !== "win32") await writeFile(join(root, "colon:name.txt"), "hello");
  // Created out of order and across directories, so neither readdir nor ripgrep's threads happen to sort them.
  for (const name of ["m", "c", "x", "a", "q", "f", "z", "b", "k", "d", "w", "e", "p", "g", "y", "h", "o", "i", "v", "j"]) {
    await mkdir(join(root, "order", name), { recursive: true });
    await writeFile(join(root, "order", name, `${name}.txt`), "zebra");
    await writeFile(join(root, "order", `${name}.txt`), "zebra");
  }

  parityRoot = await mkdtemp(join(tmpdir(), "ppm-content-search-parity-"));
  const put = async (path: string, text: string) => {
    await mkdir(join(parityRoot, path, ".."), { recursive: true });
    await writeFile(join(parityRoot, path), text);
  };
  await put("src/a.txt", "hello one\nHello two\nhello_three\nsay hello\n");
  await put("src/many.txt", "hello\n".repeat(7));
  await put("src/crlf.txt", "hello\r\nworld\r\n");
  await put("ti\u1ebfng Vi\u1ec7t.txt", "xin ch\u00e0o hello\n");
  await put(".dotdir/dot.txt", "hello\n"); // hidden: grep -r searches it
  await put(".gitignore", "ignored.txt\n");
  await put("ignored.txt", "hello\n"); // gitignored: grep never read .gitignore
  await put("build", "hello\n"); // a *file* named like an excluded directory
  await put(".git/config", "hello\n");
  await put("node_modules/pkg/index.js", "hello\n");
  await put("dist/out.txt", "hello\n");
  await put("sub/build/deep.txt", "hello\n");
  for (const name of ["app.min.js", "app.js.map", "yarn.lock", "bun.lock"]) await put(name, "hello\n");
  await put("data.bin", "hello\0binary\n");
  if (process.platform !== "win32") await put("colon:name.txt", "hello\n");
});
afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  if (parityRoot) await rm(parityRoot, { recursive: true, force: true });
});

describe("project content search", () => {
  test("finds GNU grep bundled with Git when grep is absent from PATH", async () => {
    const git = resolve(root, "Git/cmd/git.exe");
    const expected = resolve(root, "Git/usr/bin/grep.exe");
    expect(await resolveProjectSearchGrep({ platform: "win32", which: (name) => name === "git" ? git : null,
      exists: async (path) => path === expected, programFiles: "", programFilesX86: "" })).toBe(expected);
  });
  test("prefers ripgrep, falls back to grep, and reports having neither", async () => {
    const which = (found: Record<string, string>) => (name: string) => found[name] ?? null;
    expect(await resolveProjectSearchTool({ which: which({ rg: "/bin/rg", grep: "/bin/grep" }) })).toEqual({ kind: "rg", path: "/bin/rg" });
    expect(await resolveProjectSearchTool({ which: which({ grep: "/bin/grep" }) })).toEqual({ kind: "grep", path: "/bin/grep" });
    expect(await resolveProjectSearchTool({ platform: "linux", which: which({}) })).toBeUndefined();
  });
  test("does not mistake missing tools for zero matches", async () => {
    await expect(searchProjectContent(root, { query: "hello" }, { resolveTool: async () => undefined })).rejects.toMatchObject({ status: 503 });
  });
  test("real search works without grep on PATH using Windows bundled fallback", async () => {
    const fallback = await resolveProjectSearchGrep({ which: (name) => name === "grep" && process.platform === "win32" ? null : Bun.which(name) });
    expect(fallback).toBeTruthy();
    const result = await searchProjectContent(root, { query: "hello" }, { resolveTool: async () => ({ kind: "grep", path: fallback! }) });
    expect(result.results.find((r) => r.file === "src/hello world.txt")?.matches.length).toBe(5);
    expect(result.results.some((r) => r.file === "src/ti\u1ebfng Vi\u1ec7t.ts")).toBe(true);
    expect(result.results.some((r) => r.file.includes("hidden"))).toBe(false);
    if (process.platform !== "win32") expect(result.results.some((r) => r.file === "colon:name.txt")).toBe(true);
  });
});

for (const tool of tools) {
  describe(`project content search with ${tool.kind}`, () => {
    const search = (options: ProjectSearchOptions, dependencies: { maxBytes?: number } = {}) =>
      searchProjectContent(root, options, { resolveTool: async () => tool, ...dependencies });
    test("case, whole word and include filters retain expected semantics", async () => {
      const insensitive = await search({ query: "HELLO" });
      expect(insensitive.results.find((r) => r.file === "src/hello world.txt")?.matches.map((m) => m.content))
        .toEqual(["Hello world", "hello worlds", "HELLO", "hello", "hello"]);
      const sensitive = await search({ query: "Hello", caseSensitive: true });
      expect(sensitive.total).toBe(1);
      const word = await search({ query: "world", wholeWord: true, include: "src/*.txt" });
      expect(word.total).toBe(1);
      const unicode = await search({ query: "hello", include: "*.ts" });
      expect(unicode.results.map((r) => r.file)).toEqual(["src/ti\u1ebfng Vi\u1ec7t.ts"]);
    });
    test("plain text is literal; regex executes; invalid regex fails explicitly", async () => {
      expect((await search({ query: "$2.00" })).total).toBe(1);
      expect((await search({ query: "^HELLO$", regex: true, caseSensitive: true })).total).toBe(1);
      await expect(search({ query: "[", regex: true })).rejects.toMatchObject({ status: 400 });
    });
    test("no match is successful, excessive output is not silently truncated", async () => {
      expect(await search({ query: "not-present-anywhere" })).toEqual({ results: [], total: 0 });
      await expect(search({ query: "hello" }, { maxBytes: 1 })).rejects.toMatchObject({ status: 400 });
    });
    test("lists files in path order", async () => {
      const files = (await search({ query: "zebra" })).results.map((r) => r.file);
      expect(files).toHaveLength(40);
      expect(files).toEqual([...files].sort());
    });
  });
}

test.skipIf(!rgPath)("a user's ripgrep config does not change the results", async () => {
  // Both are common in a dotfiles repo, and neither is overridden by a flag the search passes:
  // long lines become a placeholder, and context lines plus `--` separators corrupt the parse.
  const config = join(parityRoot, "..", `ripgreprc-${Date.now()}`);
  await writeFile(config, "--max-columns=3\n--context=1\n");
  const rg = { kind: "rg" as const, path: rgPath! };
  const before = await searchProjectContent(parityRoot, { query: "hello" }, { resolveTool: async () => rg });
  // A child spawned without `env` gets the environment this process *started* with, so setting
  // process.env here would never reach ripgrep: the search has to run in a process started with it.
  const service = resolve(import.meta.dir, "../../../src/services/project-content-search.service.ts");
  const script = `const { searchProjectContent } = await import(${JSON.stringify(service)});
    const tool = ${JSON.stringify(rg)};
    console.log(JSON.stringify(await searchProjectContent(${JSON.stringify(parityRoot)}, { query: "hello" }, { resolveTool: async () => tool })));`;
  try {
    const child = Bun.spawn([process.execPath, "-e", script], { env: { ...process.env, RIPGREP_CONFIG_PATH: config }, stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(err).not.toContain("error");
    expect(JSON.parse(out)).toEqual(before);
  } finally {
    await rm(config, { force: true });
  }
});

test.skipIf(!rgPath || !grepPath)("ripgrep answers exactly what grep answers", async () => {
  const queries: ProjectSearchOptions[] = [
    { query: "hello" },
    { query: "Hello", caseSensitive: true },
    { query: "hello", wholeWord: true },
    { query: "hel+o", regex: true },
    { query: "hello", include: "src/**" },
  ];
  for (const options of queries) {
    const viaRg = await searchProjectContent(parityRoot, options, { resolveTool: async () => ({ kind: "rg", path: rgPath! }) });
    const viaGrep = await searchProjectContent(parityRoot, options, { resolveTool: async () => ({ kind: "grep", path: grepPath! }) });
    expect(viaRg).toEqual(viaGrep);
  }
  // Not two empty answers agreeing: the hidden, gitignored and oddly named files are searched, the excluded ones are not.
  const files = (await searchProjectContent(parityRoot, { query: "hello" }, { resolveTool: async () => ({ kind: "rg", path: rgPath! }) }))
    .results.map((r) => r.file);
  expect(files).toEqual(expect.arrayContaining([".dotdir/dot.txt", "ignored.txt", "build", "src/a.txt", "src/crlf.txt", "ti\u1ebfng Vi\u1ec7t.txt"]));
  for (const excluded of [".git/config", "node_modules/pkg/index.js", "dist/out.txt", "sub/build/deep.txt", "app.min.js", "app.js.map", "yarn.lock", "bun.lock", "data.bin"]) {
    expect(files).not.toContain(excluded);
  }
});
