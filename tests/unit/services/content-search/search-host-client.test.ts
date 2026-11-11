/**
 * The search host (`ppm __search__`) and its main-thread client.
 *
 * - The host's dispatcher is driven directly with stub `runSearch`/`runReplace`: at most 4
 *   searches at once, cancel, gzip, engine errors, the replace payload.
 * - The client is driven against the real host (spawned from source through `src/index.ts`) and
 *   against small fake hosts that speak the frame protocol: lazy spawn, ready timeout, crash,
 *   watchdog, stop — and the main thread's cost of a 20,000-match search.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { encodeFrame, type Frame, FrameDecoder } from "../../../../src/services/content-search/frame-codec.ts";
import {
  createSearchHost,
  replacePayload,
  type SearchHost,
  SearchHostError,
  searchHostCommand,
} from "../../../../src/services/content-search/search-host-client.ts";
import { createHostDispatcher } from "../../../../src/services/content-search/search-host.ts";
import { SearchRunError } from "../../../../src/services/content-search/search-run.ts";
import type { ReplaceReport, SearchRequest, SearchResponse } from "../../../../src/services/content-search/search-options.ts";

const ROOT = resolve(import.meta.dir, "../../../..");
const FRAME_CODEC = resolve(ROOT, "src/services/content-search/frame-codec.ts");
const enc = new TextEncoder();
const dec = new TextDecoder();

const hasTool = Boolean(Bun.which("rg") || Bun.which("grep"));

function searchReq(projectPath: string, query: string, extra: Partial<SearchRequest> = {}): SearchRequest {
  return {
    projectPath, query, caseSensitive: false, wholeWord: false, regex: false,
    include: [], exclude: [], useIgnore: true, gzip: false, ...extra,
  };
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitFor(cond: () => boolean, ms = 3000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await Bun.sleep(20);
  }
  return cond();
}

const scratch = mkdtempSync(join(tmpdir(), "ppm-search-host-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

// ── Host dispatcher ──────────────────────────────────────────────────────────

describe("search host dispatcher", () => {
  function harness(runSearch: (p: string, r: SearchRequest, s: AbortSignal) => Promise<SearchResponse>,
    runReplace: (p: string, r: { projectPath: string; files: unknown[] }) => Promise<ReplaceReport> = async () =>
      ({ replaced: 0, files: 0, skipped: [], failed: [] })) {
    const sent: Frame[] = [];
    const decoder = new FrameDecoder();
    const dispatcher = createHostDispatcher({
      runSearch: runSearch as never,
      runReplace: runReplace as never,
      send: (bytes: Uint8Array) => { sent.push(...decoder.push(bytes.slice())); },
    });
    const frame = (kind: Frame["kind"], id: number, payload = new Uint8Array(0)) =>
      dispatcher.handle({ kind, id, parts: [payload] });
    const search = (id: number, req: SearchRequest) => frame("search", id, enc.encode(JSON.stringify(req)));
    return { sent, frame, search };
  }
  const body = (f: Frame) => Buffer.concat(f.parts.map((p) => Buffer.from(p)));
  const empty: SearchResponse = { results: [], total: 0, files: 0, limitHit: false, engine: "rg" };

  it("runs at most 4 searches at once; the 5th waits for one to finish", async () => {
    let running = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    const h = harness(async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise<void>((r) => releases.push(r));
      running--;
      return empty;
    });
    for (let id = 1; id <= 6; id++) h.search(id, searchReq("/p", "x"));
    await Bun.sleep(10);
    expect(running).toBe(4);
    releases.shift()!();
    await waitFor(() => running === 4 && releases.length === 4, 500);
    await Bun.sleep(10);
    expect(peak).toBe(4);
    while (releases.length) { releases.shift()!(); await Bun.sleep(5); }
    expect(await waitFor(() => h.sent.length === 6, 1000)).toBe(true);
    expect(h.sent.map((f) => f.kind)).toEqual(Array(6).fill("reply"));
    expect(peak).toBe(4);
  });

  it("cancel aborts a running search and answers nothing for it", async () => {
    let seen: AbortSignal | null = null;
    const h = harness((_p, _r, signal) => {
      seen = signal;
      return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
    });
    h.search(7, searchReq("/p", "x"));
    await Bun.sleep(5);
    h.frame("cancel", 7);
    await Bun.sleep(20);
    expect(seen).not.toBeNull();
    expect(seen!.aborted).toBe(true);
    expect(h.sent).toEqual([]);
  });

  it("cancel of a queued search means it never runs", async () => {
    const started: string[] = [];
    const releases: Array<() => void> = [];
    const h = harness(async (_p, req) => {
      started.push(req.query);
      await new Promise<void>((r) => releases.push(r));
      return empty;
    });
    for (let id = 1; id <= 5; id++) h.search(id, searchReq("/p", `q${id}`));
    h.frame("cancel", 5);
    await Bun.sleep(5);
    while (releases.length) { releases.shift()!(); await Bun.sleep(5); }
    await Bun.sleep(20);
    expect(started).toEqual(["q1", "q2", "q3", "q4"]);
    expect(h.sent.map((f) => f.id).sort()).toEqual([1, 2, 3, 4]);
  });

  it("replies with a flag byte, then the JSON — gzipped when the request asked for it", async () => {
    const response: SearchResponse = { ...empty, total: 1, files: 1,
      results: [{ file: "a.ts", matches: [{ line: 1, column: 0, length: 1, before: "", cutBefore: false, text: "x", after: "" }] }] };
    const h = harness(async () => response);
    h.search(1, searchReq("/p", "x", { gzip: true }));
    h.search(2, searchReq("/p", "x", { gzip: false }));
    expect(await waitFor(() => h.sent.length === 2, 1000)).toBe(true);
    const byId = new Map(h.sent.map((f) => [f.id, body(f)]));
    const gz = byId.get(1)!;
    expect(gz[0]).toBe(1);
    expect(JSON.parse(dec.decode(Bun.gunzipSync(gz.subarray(1))))).toEqual(response);
    const plain = byId.get(2)!;
    expect(plain[0]).toBe(0);
    expect(JSON.parse(dec.decode(plain.subarray(1)))).toEqual(response);
  });

  it("answers an engine error with its status and the engine's words", async () => {
    const h = harness(async () => { throw new SearchRunError("regex parse error: unclosed group", 400); });
    h.search(3, searchReq("/p", "("));
    expect(await waitFor(() => h.sent.length === 1, 1000)).toBe(true);
    expect(h.sent[0]!.kind).toBe("reply-error");
    expect(JSON.parse(dec.decode(body(h.sent[0]!)))).toEqual({ status: 400, message: "regex parse error: unclosed group" });
  });

  it("an unexpected error is a 500 with its message", async () => {
    const h = harness(async () => { throw new Error("boom"); });
    h.search(4, searchReq("/p", "x"));
    expect(await waitFor(() => h.sent.length === 1, 1000)).toBe(true);
    expect(JSON.parse(dec.decode(body(h.sent[0]!)))).toEqual({ status: 500, message: "boom" });
  });

  it("decodes a replace payload into the project path and the browser's files", async () => {
    let got: { projectPath: string; req: unknown } | null = null;
    const report: ReplaceReport = { replaced: 2, files: 1, skipped: [], failed: [] };
    const h = harness(async () => empty, async (projectPath, req) => { got = { projectPath, req }; return report; });
    const files = [{ file: "a.ts", matches: [{ line: 1, column: 0, text: "x", replacement: "y" }] }];
    const parts = replacePayload("/proj/ü", enc.encode(JSON.stringify({ files })));
    const payload = new Uint8Array(Buffer.concat(parts.map((p) => Buffer.from(p))));
    h.frame("replace", 9, payload);
    expect(await waitFor(() => h.sent.length === 1, 1000)).toBe(true);
    expect(got!.projectPath).toBe("/proj/ü");
    expect(got!.req).toEqual({ projectPath: "/proj/ü", files });
    const reply = body(h.sent[0]!);
    expect(reply[0]).toBe(0);
    expect(JSON.parse(dec.decode(reply.subarray(1)))).toEqual(report);
  });

  it("replacePayload keeps the body as its own part, uncopied", () => {
    const bodyBytes = enc.encode('{"files":[]}');
    const parts = replacePayload("/p", bodyBytes);
    expect(parts[parts.length - 1]).toBe(bodyBytes);
  });
});

// ── Spawn command ────────────────────────────────────────────────────────────

describe("searchHostCommand", () => {
  it("re-invokes the compiled binary with the sentinel", () => {
    expect(searchHostCommand(true)).toEqual([process.execPath, "__search__"]);
  });
  it("runs the source entry through bun from a checkout", () => {
    expect(searchHostCommand(false)).toEqual([process.execPath, "run", resolve(ROOT, "src/index.ts"), "__search__"]);
  });
});

// ── Client against fake hosts ────────────────────────────────────────────────

const FAKE_HOST = join(scratch, "fake-host.ts");
writeFileSync(FAKE_HOST, `
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { encodeFrame, FrameDecoder } from ${JSON.stringify(FRAME_CODEC)};
const [mode, marker] = process.argv.slice(2);
appendFileSync(marker + ".starts", "x");
const out = (b: Uint8Array) => process.stdout.write(b);
if (mode !== "silent") out(encodeFrame("ready", 0));
const decoder = new FrameDecoder();
for await (const chunk of Bun.stdin.stream()) {
  for (const f of decoder.push(chunk)) {
    if (f.kind === "cancel") continue;
    if (mode === "crash-once" && !existsSync(marker)) { writeFileSync(marker, ""); process.exit(3); }
    if (mode === "hang") continue;
    out(encodeFrame("reply", f.id, new Uint8Array([0, ...new TextEncoder().encode('{"ok":true}')])));
  }
}
process.exit(0);
`);

let markerSeq = 0;
function fakeHost(mode: "ok" | "silent" | "crash-once" | "hang") {
  const marker = join(scratch, `m${++markerSeq}`);
  return { cmd: [process.execPath, FAKE_HOST, mode, marker], starts: () => (existsSync(`${marker}.starts`) ? readFileSync(`${marker}.starts`, "utf8").length : 0) };
}

const hosts: SearchHost[] = [];
function track(host: SearchHost): SearchHost { hosts.push(host); return host; }
afterEach(() => { while (hosts.length) hosts.pop()!.stop(); });

const ping = () => enc.encode(JSON.stringify(searchReq("/p", "x")));

describe("search host client (fake hosts)", () => {
  it("spawns lazily, once, for concurrent requests", async () => {
    const fake = fakeHost("ok");
    const host = track(createSearchHost({ cmd: fake.cmd }));
    expect(host.pid).toBeNull();
    expect(fake.starts()).toBe(0);
    const [a, b] = await Promise.all([host.request("search", ping()), host.request("search", ping())]);
    expect(await a.body.text()).toBe('{"ok":true}');
    expect(a.gzip).toBe(false);
    expect(await b.body.text()).toBe('{"ok":true}');
    expect(fake.starts()).toBe(1);
  }, 15_000);

  it("a host that cannot be spawned answers 503 with one WARN, and nothing runs in-process", async () => {
    const warns: string[] = [];
    const host = track(createSearchHost({ cmd: [join(scratch, "no-such-binary")], warn: (m) => warns.push(m) }));
    const err = await host.request("search", ping()).catch((e) => e);
    expect(err).toBeInstanceOf(SearchHostError);
    expect(err.status).toBe(503);
    expect(err.message).toMatch(/^Search could not start: /);
    expect(warns.length).toBe(1);
  }, 15_000);

  it("a host that never says ready is killed after the ready timeout: 503", async () => {
    const fake = fakeHost("silent");
    const warns: string[] = [];
    const host = track(createSearchHost({ cmd: fake.cmd, readyTimeoutMs: 400, warn: (m) => warns.push(m) }));
    const started = Date.now();
    const err = await host.request("search", ping()).catch((e) => e);
    expect(err).toBeInstanceOf(SearchHostError);
    expect(err.status).toBe(503);
    expect(err.message).toMatch(/^Search could not start: /);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(warns.length).toBe(1);
  }, 15_000);

  it("a crash fails the pending request with 500, and the next request gets a fresh host", async () => {
    const fake = fakeHost("crash-once");
    const host = track(createSearchHost({ cmd: fake.cmd, warn: () => {} }));
    const err = await host.request("search", ping()).catch((e) => e);
    expect(err).toBeInstanceOf(SearchHostError);
    expect(err.status).toBe(500);
    expect(err.message).toContain("the search process exited (code 3)");
    const ok = await host.request("search", ping());
    expect(await ok.body.text()).toBe('{"ok":true}');
    expect(fake.starts()).toBe(2);
  }, 15_000);

  it("the watchdog kills a host that does not answer in time", async () => {
    const fake = fakeHost("hang");
    const host = track(createSearchHost({ cmd: fake.cmd, warn: () => {} }));
    await host.ensureStarted();
    const pid = host.pid!;
    const err = await host.request("search", ping(), { deadlineMs: 300 }).catch((e) => e);
    expect(err).toBeInstanceOf(SearchHostError);
    expect(err.status).toBe(500);
    expect(await waitFor(() => !alive(pid))).toBe(true);
    await host.ensureStarted();
    expect(host.pid).not.toBe(pid);
    expect(fake.starts()).toBe(2);
  }, 15_000);

  it("stop() ends the host and fails what is pending", async () => {
    const fake = fakeHost("hang");
    const host = track(createSearchHost({ cmd: fake.cmd, warn: () => {} }));
    await host.ensureStarted();
    const pid = host.pid!;
    const pending = host.request("search", ping()).catch((e) => e);
    host.stop();
    expect(await pending).toBeInstanceOf(SearchHostError);
    expect(await waitFor(() => !alive(pid))).toBe(true);
    expect(host.pid).toBeNull();
  }, 15_000);

  it("an aborted request rejects at once and sends the host a cancel", async () => {
    const fake = fakeHost("hang");
    const host = track(createSearchHost({ cmd: fake.cmd, warn: () => {} }));
    await host.ensureStarted();
    const pid = host.pid;
    const ctrl = new AbortController();
    const pending = host.request("search", ping(), { signal: ctrl.signal }).catch((e) => e);
    ctrl.abort();
    const err = await pending;
    expect(err).not.toBeInstanceOf(SearchHostError);
    expect((err as Error).name).toBe("AbortError");
    expect(host.pid).toBe(pid);
    expect(alive(pid!)).toBe(true);
  }, 15_000);
});

// ── Client against the real host ─────────────────────────────────────────────

describe.skipIf(!hasTool)("search host client (real host)", () => {
  const project = join(scratch, "project");
  beforeAll(() => {
    mkdirSync(project, { recursive: true });
    const lines = Array.from({ length: 100 }, (_, i) => `const needle${i} = ${i}; // needle`).join("\n");
    for (let f = 0; f < 100; f++) writeFileSync(join(project, `f${String(f).padStart(3, "0")}.ts`), `${lines}\n`);
    writeFileSync(join(project, "small.txt"), "haystack\nonly-once-word\n");
  });

  it("answers a real search and a real replace", async () => {
    const host = track(createSearchHost());
    const reply = await host.request("search", enc.encode(JSON.stringify(searchReq(project, "only-once-word"))));
    expect(reply.gzip).toBe(false);
    const res = JSON.parse(await reply.body.text()) as SearchResponse;
    expect(res.total).toBe(1);
    expect(res.results[0]!.file).toBe("small.txt");

    const files = [{ file: "small.txt", matches: [{ line: 2, column: 0, text: "only-once-word", replacement: "replaced" }] }];
    const rep = await host.request("replace", replacePayload(project, enc.encode(JSON.stringify({ files }))));
    const report = JSON.parse(await rep.body.text()) as ReplaceReport;
    expect(report).toEqual({ replaced: 1, files: 1, skipped: [], failed: [] });
    expect(readFileSync(join(project, "small.txt"), "utf8")).toBe("haystack\nreplaced\n");
  }, 30_000);

  it("an engine error comes back as a SearchHostError with the engine's status", async () => {
    const host = track(createSearchHost());
    const err = await host.request("search", enc.encode(JSON.stringify(searchReq(project, "(", { regex: true })))).catch((e) => e);
    expect(err).toBeInstanceOf(SearchHostError);
    expect(err.status).toBe(400);
  }, 30_000);

  it("20,000 matches cost the main thread a few short tasks, not one per match", async () => {
    const tasks: number[] = [];
    let measuring = false;
    const host = track(createSearchHost({ onMainThreadTask: (ms) => { if (measuring) tasks.push(ms); } }));
    await host.ensureStarted();

    const run = async (query: string) => {
      tasks.length = 0;
      measuring = true;
      const reply = await host.request("search", enc.encode(JSON.stringify(searchReq(project, query, { gzip: true }))));
      measuring = false;
      expect(reply.gzip).toBe(true);
      const res = JSON.parse(dec.decode(Bun.gunzipSync(new Uint8Array(await reply.body.arrayBuffer())))) as SearchResponse;
      return { res, tasks: [...tasks] };
    };

    const small = await run("haystack");
    expect(small.res.total).toBe(1);
    const big = await run("needle");
    expect(big.res.total).toBe(20_000);
    expect(big.res.limitHit).toBe(false);

    expect(big.tasks.length).toBeGreaterThan(0);
    for (const ms of big.tasks) expect(ms).toBeLessThan(5);
    expect(big.tasks.length).toBeLessThanOrEqual(small.tasks.length + 8);
  }, 60_000);
});
