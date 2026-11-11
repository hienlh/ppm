import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
// Isolates PPM_HOME and loads the config service before any service import reaches a database.
import "../../test-setup.ts";
import { Hono } from "hono";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileRoutes, setSearchHostForTests } from "../../../src/server/routes/files.ts";
import { gzipJson } from "../../../src/server/middleware/gzip-json.ts";
import {
  replacePayload,
  SearchHostError,
  stopSearchHost,
  type RequestOptions,
  type SearchHost,
  type SearchHostReply,
} from "../../../src/services/content-search/search-host-client.ts";
import type { SearchRequest, SearchResponse } from "../../../src/services/content-search/search-options.ts";
import * as legacySearch from "../../../src/services/project-content-search.service.ts";

const PROJECT = "/tmp/fake-project";

interface Call { kind: "search" | "replace"; bytes: Uint8Array; options: RequestOptions }

function join8(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.byteLength; }
  return out;
}

/** A host that records what the route hands it and answers with `answer`. */
function fakeHost(answer: (call: Call) => Promise<SearchHostReply> = async () => ({ body: new Blob(["{}"]), gzip: false })) {
  const calls: Call[] = [];
  let warmed = 0;
  const host: SearchHost = {
    pid: null,
    async ensureStarted() { warmed++; },
    request(kind, payload, options = {}) {
      const call = { kind, bytes: join8(payload instanceof Uint8Array ? [payload] : payload), options };
      calls.push(call);
      return answer(call);
    },
    stop() {},
  };
  return { host, calls, warmed: () => warmed };
}

function app() {
  const a = new Hono<{ Variables: { projectPath: string; projectName: string } }>();
  a.use("/api/*", gzipJson);
  a.use("*", (c, next) => {
    c.set("projectPath", PROJECT);
    c.set("projectName", "fake");
    return next();
  });
  return a.route("/api/files", fileRoutes);
}

const searchRequest = (call: Call) => JSON.parse(new TextDecoder().decode(call.bytes)) as SearchRequest;

afterEach(() => setSearchHostForTests(null));

describe("GET /files/search", () => {
  test("an empty query warms the host and searches nothing", async () => {
    const fake = fakeHost();
    setSearchHostForTests(fake.host);
    const res = await app().request("/api/files/search?q=");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data ?? body).toMatchObject({ results: [], total: 0 });
    expect(fake.warmed()).toBe(1);
    expect(fake.calls).toHaveLength(0);
  });

  test("hands every option to the host as a search request for this project", async () => {
    const fake = fakeHost();
    setSearchHostForTests(fake.host);
    const q = new URLSearchParams({
      q: " foo(bar) ",
      caseSensitive: "true",
      wholeWord: "true",
      regex: "true",
      include: "src/**, *.{ts,tsx} ,",
      exclude: "dist,  **/*.min.js",
      useIgnore: "false",
      replace: "$1-x",
      preserveCase: "true",
    });
    await app().request(`/api/files/search?${q}`, { headers: { "Accept-Encoding": "gzip, br" } });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.kind).toBe("search");
    expect(searchRequest(fake.calls[0]!)).toEqual({
      projectPath: PROJECT,
      query: " foo(bar) ",
      caseSensitive: true,
      wholeWord: true,
      regex: true,
      include: ["src/**", "*.{ts,tsx}"],
      exclude: ["dist", "**/*.min.js"],
      useIgnore: false,
      replace: "$1-x",
      preserveCase: true,
      gzip: true,
    });
  });

  test("defaults: ignore files on, no replace, no gzip without Accept-Encoding", async () => {
    const fake = fakeHost();
    setSearchHostForTests(fake.host);
    await app().request("/api/files/search?q=hello");
    expect(fake.calls).toHaveLength(1);
    const req = searchRequest(fake.calls[0]!);
    expect(req).toMatchObject({ query: "hello", caseSensitive: false, wholeWord: false, regex: false,
      include: [], exclude: [], useIgnore: true, gzip: false });
    expect(req.replace).toBeUndefined();
    // An open replace field with nothing in it still replaces (it deletes the matches).
    await app().request("/api/files/search?q=hello&replace=");
    expect(searchRequest(fake.calls[1]!).replace).toBe("");
  });

  test("sends a gzipped reply as it is, with Content-Encoding, and gzip-json leaves it alone", async () => {
    const response: SearchResponse = { results: [], total: 0, files: 0, limitHit: false, engine: "rg" };
    const gzipped = Bun.gzipSync(new TextEncoder().encode(JSON.stringify({ ...response, pad: "x".repeat(4000) })));
    const fake = fakeHost(async () => ({ body: new Blob([gzipped]), gzip: true }));
    setSearchHostForTests(fake.host);
    const res = await app().request("/api/files/search?q=hello", { headers: { "Accept-Encoding": "gzip" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Encoding")).toBe("gzip");
    expect(res.headers.get("Content-Type")).toContain("application/json");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(gzipped);
  });

  test("sends a plain reply byte for byte, unwrapped", async () => {
    const text = JSON.stringify({ results: [{ file: "a.ts", matches: [] }], total: 0, files: 1, limitHit: false, engine: "rg" });
    const fake = fakeHost(async () => ({ body: new Blob([text]), gzip: false }));
    setSearchHostForTests(fake.host);
    const res = await app().request("/api/files/search?q=hello");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Encoding")).toBeNull();
    expect(res.headers.get("Content-Type")).toContain("application/json");
    expect(await res.text()).toBe(text);
  });

  test("answers a host error with its status and message", async () => {
    for (const [status, message] of [[400, "regex parse error: unclosed group"], [503, "Search could not start: boom"], [500, "Search failed: the search process exited (code 9)"]] as const) {
      setSearchHostForTests(fakeHost(async () => { throw new SearchHostError(status, message); }).host);
      const res = await app().request("/api/files/search?q=(");
      expect(res.status).toBe(status);
      expect(await res.json()).toEqual({ ok: false, error: message });
    }
  });

  test("the request's abort reaches the host", async () => {
    let seen: AbortSignal | undefined;
    const fake = fakeHost((call) => new Promise((_, reject) => {
      seen = call.options.signal;
      seen?.addEventListener("abort", () => reject(seen!.reason), { once: true });
    }));
    setSearchHostForTests(fake.host);
    const controller = new AbortController();
    const pending = app().request("/api/files/search?q=hello", { signal: controller.signal });
    await Bun.sleep(5);
    expect(seen).toBeDefined();
    expect(seen!.aborted).toBe(false);
    controller.abort();
    await pending.catch(() => {});
    expect(seen!.aborted).toBe(true);
  });

  test("raises Bun's idle timeout to 40 s for a search", async () => {
    setSearchHostForTests(fakeHost().host);
    const timeouts: number[] = [];
    const env = { timeout: (_req: Request, seconds: number) => { timeouts.push(seconds); } };
    await app().request("/api/files/search?q=hello", {}, env);
    expect(timeouts).toEqual([40]);
  });
});

describe("POST /files/replace", () => {
  test("hands the body to the host untouched, behind the project path", async () => {
    const reportText = JSON.stringify({ replaced: 2, files: 1, skipped: [], failed: [] });
    const fake = fakeHost(async () => ({ body: new Blob([reportText]), gzip: false }));
    setSearchHostForTests(fake.host);
    // Not valid JSON on purpose: the route must not parse it.
    const body = new TextEncoder().encode('{"files": [ not json, é ');
    const res = await app().request("/api/files/replace", { method: "POST", body, headers: { "Content-Type": "application/json" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    expect(await res.text()).toBe(reportText);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.kind).toBe("replace");
    expect(fake.calls[0]!.bytes).toEqual(join8(replacePayload(PROJECT, body)));
  });

  test("answers a host error with its status and message", async () => {
    setSearchHostForTests(fakeHost(async () => { throw new SearchHostError(400, "Replace request has no files"); }).host);
    const res = await app().request("/api/files/replace", { method: "POST", body: "{}" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: "Replace request has no files" });
  });
});

test("the old in-server search is gone; only the tool resolvers stay", () => {
  expect("searchProjectContent" in legacySearch).toBe(false);
  expect(typeof legacySearch.resolveProjectSearchTool).toBe("function");
  expect(typeof legacySearch.resolveProjectSearchGrep).toBe("function");
});

// Through the real `ppm __search__` host: search, then replace what it found.
describe.skipIf(!Bun.which("rg"))("through the real search host", () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "ppm-files-search-route-"));
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "a.ts"), "const hello = 1;\nhello(hello);\n");
  });
  afterAll(async () => {
    stopSearchHost();
    if (root) await rm(root, { recursive: true, force: true });
  });

  test("finds every match and replaces them", async () => {
    const real = new Hono<{ Variables: { projectPath: string; projectName: string } }>();
    real.use("*", (c, next) => { c.set("projectPath", root); c.set("projectName", "r"); return next(); });
    real.route("/files", fileRoutes);

    const res = await real.request("/files/search?q=hello&replace=bye");
    expect(res.status).toBe(200);
    const found = await res.json() as SearchResponse;
    expect(found.total).toBe(3);
    const files = found.results.map((r) => ({ file: r.file,
      matches: r.matches.map((m) => ({ line: m.line, column: m.column, text: m.text, replacement: m.replacement! })) }));

    const replaced = await real.request("/files/replace", { method: "POST", body: JSON.stringify({ files }) });
    expect(replaced.status).toBe(200);
    expect(await replaced.json()).toMatchObject({ replaced: 3, files: 1, skipped: [], failed: [] });
    expect(await Bun.file(join(root, "src", "a.ts")).text()).toBe("const bye = 1;\nbye(bye);\n");
  }, 20_000);
});
