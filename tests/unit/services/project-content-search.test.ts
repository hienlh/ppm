import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveProjectSearchGrep, searchProjectContent } from "../../../src/services/project-content-search.service";

let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "ppm-content-search-"));
  await mkdir(join(root, "src"));
  await mkdir(join(root, "node_modules"));
  await writeFile(join(root, "src", "hello world.txt"), "Hello world\nhello worlds\nHELLO\nhello\nhello\nhello\nhello\n");
  await writeFile(join(root, "src", "ti\u1ebfng Vi\u1ec7t.ts"), "hello: Unicode\nprice $2.00\n");
  await writeFile(join(root, "node_modules", "hidden.txt"), "hello");
  await writeFile(join(root, "hidden.min.js"), "hello");
  if (process.platform !== "win32") await writeFile(join(root, "colon:name.txt"), "hello");
});
afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });

describe("project content search", () => {
  test("finds GNU grep bundled with Git when grep is absent from PATH", async () => {
    const git = resolve(root, "Git/cmd/git.exe");
    const expected = resolve(root, "Git/usr/bin/grep.exe");
    expect(await resolveProjectSearchGrep({ platform: "win32", which: (name) => name === "git" ? git : null,
      exists: async (path) => path === expected, programFiles: "", programFilesX86: "" })).toBe(expected);
  });
  test("does not mistake missing tools for zero matches", async () => {
    await expect(searchProjectContent(root, { query: "hello" }, { resolveGrep: async () => undefined })).rejects.toMatchObject({ status: 503 });
  });
  test("real search works without grep on PATH using Windows bundled fallback", async () => {
    const fallback = await resolveProjectSearchGrep({ which: (name) => name === "grep" && process.platform === "win32" ? null : Bun.which(name) });
    expect(fallback).toBeTruthy();
    const result = await searchProjectContent(root, { query: "hello" }, { resolveGrep: async () => fallback });
    expect(result.results.find((r) => r.file === "src/hello world.txt")?.matches.length).toBe(5);
    expect(result.results.some((r) => r.file === "src/ti\u1ebfng Vi\u1ec7t.ts")).toBe(true);
    expect(result.results.some((r) => r.file.includes("hidden"))).toBe(false);
    if (process.platform !== "win32") expect(result.results.some((r) => r.file === "colon:name.txt")).toBe(true);
  });
  test("case, whole word and include filters retain expected semantics", async () => {
    const sensitive = await searchProjectContent(root, { query: "Hello", caseSensitive: true });
    expect(sensitive.total).toBe(1);
    const word = await searchProjectContent(root, { query: "world", wholeWord: true, include: "src/*.txt" });
    expect(word.total).toBe(1);
    const unicode = await searchProjectContent(root, { query: "hello", include: "*.ts" });
    expect(unicode.results.map((r) => r.file)).toEqual(["src/ti\u1ebfng Vi\u1ec7t.ts"]);
  });
  test("plain text is literal; regex executes; invalid regex fails explicitly", async () => {
    expect((await searchProjectContent(root, { query: "$2.00" })).total).toBe(1);
    expect((await searchProjectContent(root, { query: "^HELLO$", regex: true, caseSensitive: true })).total).toBe(1);
    await expect(searchProjectContent(root, { query: "[", regex: true })).rejects.toMatchObject({ status: 400 });
  });
  test("no match is successful, excessive output is not silently truncated", async () => {
    expect(await searchProjectContent(root, { query: "not-present-anywhere" })).toEqual({ results: [], total: 0 });
    await expect(searchProjectContent(root, { query: "hello" }, { maxBytes: 1 })).rejects.toMatchObject({ status: 400 });
  });
});
