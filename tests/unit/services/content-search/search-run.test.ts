import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { runSearch, SearchRunError } from "../../../../src/services/content-search/search-run.ts";
import { MAX_MATCHES, type SearchRequest, type SearchResponse } from "../../../../src/services/content-search/search-options.ts";

const RG = Bun.which("rg");
const GREP = ["/usr/bin/grep", "/bin/grep"].find((p) => existsSync(p)) ?? Bun.which("grep");

let root: string;
let project: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ppm-search-run-"));
  project = join(root, "project");
  mkdirSync(project);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function put(rel: string, content: string): void {
  const path = join(project, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function req(query: string, extra: Partial<SearchRequest> = {}): SearchRequest {
  return {
    projectPath: project,
    query,
    caseSensitive: false,
    wholeWord: false,
    regex: false,
    include: [],
    exclude: [],
    useIgnore: true,
    gzip: false,
    ...extra,
  };
}

const rgTool = async () => (RG ? { kind: "rg" as const, path: RG } : undefined);
const grepTool = async () => (GREP ? { kind: "grep" as const, path: GREP } : undefined);

const files = (res: SearchResponse) => res.results.map((r) => r.file);

/** A stand-in search tool: a shell script that records its pid, prints `stdout`, then runs `tail`. */
function fakeTool(name: string, stdout: string, tail: string): { path: string; pidFile: string } {
  const pidFile = join(root, `${name}.pid`);
  const out = join(root, `${name}.out`);
  writeFileSync(out, stdout);
  const path = join(root, name);
  writeFileSync(path, `#!/bin/sh\necho $$ > '${pidFile}'\ncat '${out}'\n${tail}\n`);
  chmodSync(path, 0o755);
  return { path, pidFile };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean, ms = 3000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error("timed out waiting");
    await Bun.sleep(10);
  }
}

function rgMatchLine(file: string, line: number, text: string, start: number, end: number): string {
  return JSON.stringify({
    type: "match",
    data: {
      path: { text: `./${file}` },
      lines: { text: `${text}\n` },
      line_number: line,
      absolute_offset: 0,
      submatches: [{ match: { text: text.slice(start, end) }, start, end }],
    },
  }) + "\n";
}

describe.skipIf(!RG)("runSearch with ripgrep: every match", () => {
  test("returns every matching line of a file, with no per-file cap", async () => {
    put("a.txt", Array.from({ length: 100 }, (_, i) => `hit ${i}`).join("\n") + "\n");
    const res = await runSearch(project, req("hit"), undefined, { resolveTool: rgTool });
    expect(res.engine).toBe("rg");
    expect(res.results).toHaveLength(1);
    expect(res.results[0]!.matches).toHaveLength(100);
    expect(res.total).toBe(100);
    expect(res.files).toBe(1);
    expect(res.limitHit).toBe(false);
    expect(res.incomplete).toBeUndefined();
  });

  test("reports each match of a line with its column, and counts each one", async () => {
    put("a.txt", "foo bar foo\n");
    const res = await runSearch(project, req("foo"), undefined, { resolveTool: rgTool });
    expect(res.results[0]!.matches.map((m) => [m.line, m.column, m.length, m.text])).toEqual([
      [1, 0, 3, "foo"],
      [1, 8, 3, "foo"],
    ]);
    expect(res.total).toBe(2);
  });

  test("sorts files by path and totals matches and files", async () => {
    put("z.txt", "needle\n");
    put("a/b.txt", "needle needle\n");
    put("m.txt", "needle\n");
    put("none.txt", "nothing\n");
    const res = await runSearch(project, req("needle"), undefined, { resolveTool: rgTool });
    expect(files(res)).toEqual(["a/b.txt", "m.txt", "z.txt"]);
    expect(res.total).toBe(4);
    expect(res.files).toBe(3);
  });

  test("an empty query searches nothing", async () => {
    put("a.txt", "anything\n");
    const res = await runSearch(project, req(""), undefined, { resolveTool: rgTool });
    expect(res.results).toEqual([]);
    expect(res.total).toBe(0);
    expect(res.files).toBe(0);
  });

  test("no match is an empty answer, not an error", async () => {
    put("a.txt", "anything\n");
    const res = await runSearch(project, req("zzz-not-here"), undefined, { resolveTool: rgTool });
    expect(res).toMatchObject({ results: [], total: 0, files: 0, limitHit: false, engine: "rg" });
  });
});

describe.skipIf(!RG)("runSearch with ripgrep: options", () => {
  test("skips .gitignore'd files while ignore files are on, and searches them when off", async () => {
    mkdirSync(join(project, ".git"));
    put(".gitignore", "ignored.txt\n");
    put("ignored.txt", "needle\n");
    put("kept.txt", "needle\n");
    put("node_modules/pkg/index.js", "needle\n");
    const on = await runSearch(project, req("needle"), undefined, { resolveTool: rgTool });
    expect(files(on)).toEqual(["kept.txt"]);
    const off = await runSearch(project, req("needle", { useIgnore: false }), undefined, { resolveTool: rgTool });
    expect(files(off)).toEqual(["ignored.txt", "kept.txt", "node_modules/pkg/index.js"]);
  });

  test("applies include and exclude globs", async () => {
    put("src/a.ts", "needle\n");
    put("src/b.ts", "needle\n");
    put("src/c.js", "needle\n");
    const res = await runSearch(project, req("needle", { include: ["*.ts"], exclude: ["b.ts"] }), undefined, {
      resolveTool: rgTool,
    });
    expect(files(res)).toEqual(["src/a.ts"]);
  });

  test("Whole Word and Regex together bound the regex by word boundaries", async () => {
    put("a.txt", "foo food fooo xfoo\n");
    const res = await runSearch(project, req("fo+", { regex: true, wholeWord: true }), undefined, {
      resolveTool: rgTool,
    });
    expect(res.results[0]!.matches.map((m) => m.text)).toEqual(["foo", "fooo"]);
  });

  test("searches look-around through PCRE2", async () => {
    put("a.txt", "foobar foobaz\n");
    const res = await runSearch(project, req("foo(?=baz)", { regex: true, caseSensitive: true }), undefined, {
      resolveTool: rgTool,
    });
    expect(res.results[0]!.matches.map((m) => m.column)).toEqual([7]);
  });

  test("gives each match its replacement, keeping the case shape under Preserve Case", async () => {
    put("a.txt", "Foo FOO foo\n");
    const plain = await runSearch(project, req("foo", { replace: "bar" }), undefined, { resolveTool: rgTool });
    expect(plain.results[0]!.matches.map((m) => m.replacement)).toEqual(["bar", "bar", "bar"]);
    const kept = await runSearch(project, req("foo", { replace: "bar", preserveCase: true }), undefined, {
      resolveTool: rgTool,
    });
    expect(kept.results[0]!.matches.map((m) => m.replacement)).toEqual(["Bar", "BAR", "bar"]);
  });

  test("expands capture groups in the replacement", async () => {
    put("a.txt", "key=value\n");
    const res = await runSearch(project, req("(\\w+)=(\\w+)", { regex: true, replace: "$2:$1" }), undefined, {
      resolveTool: rgTool,
    });
    expect(res.results[0]!.matches[0]!.replacement).toBe("value:key");
  });
});

describe.skipIf(!RG)("runSearch: the match limit", () => {
  test("stops at MAX_MATCHES (20,000) and says the results were cut short", async () => {
    put("big.txt", "hit\n".repeat(MAX_MATCHES + 50));
    const res = await runSearch(project, req("hit"), undefined, { resolveTool: rgTool });
    expect(res.total).toBe(MAX_MATCHES);
    expect(res.results[0]!.matches).toHaveLength(MAX_MATCHES);
    expect(res.limitHit).toBe(true);
  });

  test("cuts inside a line holding several matches", async () => {
    put("a.txt", "x x x\nx x x\n");
    const res = await runSearch(project, req("x"), undefined, { resolveTool: rgTool, maxMatches: 4 });
    expect(res.total).toBe(4);
    expect(res.results[0]!.matches.map((m) => [m.line, m.column])).toEqual([
      [1, 0],
      [1, 2],
      [1, 4],
      [2, 0],
    ]);
    expect(res.limitHit).toBe(true);
  });

  test("exactly the limit is not a cut", async () => {
    put("a.txt", "x\nx\nx\n");
    const res = await runSearch(project, req("x"), undefined, { resolveTool: rgTool, maxMatches: 3 });
    expect(res.total).toBe(3);
    expect(res.limitHit).toBe(false);
  });
});

describe("runSearch: time limit and cancel", () => {
  test("at the time limit, stops the tool and answers the matches found so far", async () => {
    const fake = fakeTool("rg-slow", rgMatchLine("a.txt", 3, "found it", 0, 5), "exec sleep 30");
    const started = Date.now();
    const res = await runSearch(project, req("found"), undefined, {
      resolveTool: async () => ({ kind: "rg", path: fake.path }),
      timeLimitMs: 300,
    });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(res.incomplete).toBe("timeout");
    expect(res.results).toEqual([
      {
        file: "a.txt",
        matches: [expect.objectContaining({ line: 3, column: 0, length: 5, text: "found" })],
      },
    ]);
    expect(res.total).toBe(1);
    expect(res.files).toBe(1);
    const pid = Number(readFileSync(fake.pidFile, "utf8"));
    expect(alive(pid)).toBe(false);
  });

  test("abort kills the tool and rejects with an AbortError", async () => {
    const fake = fakeTool("rg-hang", "", "exec sleep 30");
    const controller = new AbortController();
    const run = runSearch(project, req("x"), controller.signal, {
      resolveTool: async () => ({ kind: "rg", path: fake.path }),
    });
    await waitFor(() => existsSync(fake.pidFile) && readFileSync(fake.pidFile, "utf8").trim() !== "");
    const pid = Number(readFileSync(fake.pidFile, "utf8"));
    controller.abort();
    const err = await run.then(() => null, (e: unknown) => e as Error);
    expect(err?.name).toBe("AbortError");
    expect(alive(pid)).toBe(false);
  });

  test("an already aborted signal runs no tool", async () => {
    const fake = fakeTool("rg-never", "", "exit 0");
    const controller = new AbortController();
    controller.abort();
    const err = await runSearch(project, req("x"), controller.signal, {
      resolveTool: async () => ({ kind: "rg", path: fake.path }),
    }).then(() => null, (e: unknown) => e as Error);
    expect(err?.name).toBe("AbortError");
    expect(existsSync(fake.pidFile)).toBe(false);
  });
});

describe("runSearch: engine errors", () => {
  test.skipIf(!RG)("an invalid regex answers 400 with ripgrep's own words", async () => {
    put("a.txt", "x\n");
    const err = await runSearch(project, req("(", { regex: true }), undefined, { resolveTool: rgTool }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SearchRunError);
    expect((err as SearchRunError).status).toBe(400);
    expect((err as SearchRunError).message).toContain("regex parse error");
    expect((err as SearchRunError).message).toContain("unclosed group");
  });

  test.skipIf(!GREP)("an invalid regex answers 400 with grep's own words", async () => {
    put("a.txt", "x\n");
    const err = await runSearch(project, req("(", { regex: true }), undefined, {
      resolveTool: grepTool,
      gitPath: null,
    }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(SearchRunError);
    expect((err as SearchRunError).status).toBe(400);
    expect((err as SearchRunError).message).toContain("Unmatched ( or \\(");
  });

  test("no search tool answers 503", async () => {
    const err = await runSearch(project, req("x"), undefined, { resolveTool: async () => undefined }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SearchRunError);
    expect((err as SearchRunError).status).toBe(503);
    expect((err as SearchRunError).message).toContain("ripgrep");
  });

  test("a tool that cannot be started answers 503", async () => {
    const err = await runSearch(project, req("x"), undefined, {
      resolveTool: async () => ({ kind: "rg", path: join(root, "no-such-rg") }),
    }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(SearchRunError);
    expect((err as SearchRunError).status).toBe(503);
  });

  test("a failure that is not the pattern answers 500 with the tool's words", async () => {
    const fake = fakeTool("rg-broken", "", "echo 'something broke' >&2\nexit 2");
    const err = await runSearch(project, req("x"), undefined, {
      resolveTool: async () => ({ kind: "rg", path: fake.path }),
    }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(SearchRunError);
    expect((err as SearchRunError).status).toBe(500);
    expect((err as SearchRunError).message).toContain("something broke");
  });

  test("matches found beside an unreadable file are still answered", async () => {
    const fake = fakeTool(
      "rg-partial",
      rgMatchLine("a.txt", 1, "needle", 0, 6),
      "echo 'rg: ./secret: Permission denied (os error 13)' >&2\nexit 2",
    );
    const res = await runSearch(project, req("needle"), undefined, {
      resolveTool: async () => ({ kind: "rg", path: fake.path }),
    });
    expect(files(res)).toEqual(["a.txt"]);
    expect(res.total).toBe(1);
  });
});

describe.skipIf(!GREP)("runSearch with the grep fallback", () => {
  test("lists every match with its column, sorted, totalled", async () => {
    put("b.txt", "foo bar foo\n");
    put("a/c.txt", Array.from({ length: 30 }, () => "foo").join("\n") + "\n");
    const res = await runSearch(project, req("foo"), undefined, { resolveTool: grepTool, gitPath: null });
    expect(res.engine).toBe("grep");
    expect(files(res)).toEqual(["a/c.txt", "b.txt"]);
    expect(res.results[0]!.matches).toHaveLength(30);
    expect(res.results[1]!.matches.map((m) => m.column)).toEqual([0, 8]);
    expect(res.total).toBe(32);
    expect(res.files).toBe(2);
    expect(res.replaceUnavailable).toBeUndefined();
  });

  test("leaves the default excluded folders out, and applies include and exclude", async () => {
    put("src/a.ts", "needle\n");
    put("src/b.ts", "needle\n");
    put("src/c.js", "needle\n");
    put("node_modules/x/index.ts", "needle\n");
    const res = await runSearch(project, req("needle", { include: ["*.ts"], exclude: ["b.ts"] }), undefined, {
      resolveTool: grepTool,
      gitPath: null,
    });
    expect(files(res)).toEqual(["src/a.ts"]);
  });

  test("gives replacements, with Preserve Case", async () => {
    put("a.txt", "Foo foo\n");
    const res = await runSearch(project, req("foo", { replace: "bar", preserveCase: true }), undefined, {
      resolveTool: grepTool,
      gitPath: null,
    });
    expect(res.results[0]!.matches.map((m) => m.replacement)).toEqual(["Bar", "bar"]);
  });

  test("a pattern JavaScript cannot run matches the whole line and sets replaceUnavailable", async () => {
    put("a.txt", "foo\n");
    const res = await runSearch(project, req("o**", { regex: true, replace: "x" }), undefined, {
      resolveTool: grepTool,
      gitPath: null,
    });
    expect(res.replaceUnavailable).toBe(true);
    expect(res.results[0]!.matches).toEqual([expect.objectContaining({ column: 0, length: 3, text: "foo" })]);
    expect(res.results[0]!.matches[0]!.replacement).toBeUndefined();
  });

  test("stops at the match limit", async () => {
    put("a.txt", "x\nx\nx\nx\n");
    const res = await runSearch(project, req("x"), undefined, { resolveTool: grepTool, gitPath: null, maxMatches: 2 });
    expect(res.total).toBe(2);
    expect(res.limitHit).toBe(true);
  });
});
