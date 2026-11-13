/**
 * The background embedding queue against a temp index and a fake embedder: what gets embedded
 * (missing or stale vectors, never archived or up-to-date ones), batches of 16 one at a time,
 * failures and hangs recorded as a reason and retried on the next kick, a model change dropping
 * the old model's vectors, and the counts Settings shows. Everything lives under a temp PPM_HOME.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const originalPpmHome = process.env.PPM_HOME;
const home = mkdtempSync(join(tmpdir(), "ppm-embed-queue-"));
process.env.PPM_HOME = home;

import { _resetPpmDir } from "../../../src/services/ppm-dir.ts";
import { serializeMemoryFile } from "../../../src/services/memory/memory-file.ts";
import { GLOBAL_MEMORY_KEY, MemoryIndex } from "../../../src/services/memory/memory-index.ts";
import type { Embedder, EmbedKind } from "../../../src/services/memory/embedding/embedder.ts";

_resetPpmDir();

// Loaded dynamically so a missing module fails the assertions below, not the file's load.
const MODULE = "../../../src/services/memory/embedding/embed-queue.ts";
let mod: any = null;
const opened: MemoryIndex[] = [];

beforeAll(async () => {
  mod = await import(MODULE).catch(() => null);
});

afterAll(() => {
  for (const idx of opened) {
    try { idx.close(); } catch { /* already closed */ }
  }
  if (originalPpmHome === undefined) delete process.env.PPM_HOME;
  else process.env.PPM_HOME = originalPpmHome;
  _resetPpmDir();
  rmSync(home, { recursive: true, force: true });
});

function api() {
  expect(mod).not.toBeNull();
  return mod;
}

const KEY = "abcdef0123456789";
const OTHER_KEY = "0123456789abcdef";

let seq = 0;
/** A fresh index next to its own `global` and `projects/<key>` folders. */
function fresh() {
  const base = join(home, `case-${++seq}`);
  const dir = join(base, "projects", KEY);
  const otherDir = join(base, "projects", OTHER_KEY);
  const globalDir = join(base, "global");
  for (const d of [dir, otherDir, globalDir]) mkdirSync(d, { recursive: true });
  const index = MemoryIndex.open(join(base, "index.db"));
  opened.push(index);
  const reconcileAll = async () => {
    await index.reconcile(dir, "project", KEY);
    await index.reconcile(otherDir, "project", OTHER_KEY);
    await index.reconcile(globalDir, "global", GLOBAL_MEMORY_KEY);
  };
  return { base, dir, otherDir, globalDir, index, reconcileAll };
}

interface Fields { name?: string; description?: string; body?: string; archived?: boolean }
function writeMemory(dir: string, id: string, f: Fields = {}): void {
  writeFileSync(join(dir, `${id}.md`), serializeMemoryFile({
    name: f.name ?? `name of ${id}`,
    description: f.description ?? `about ${id}`,
    type: "project",
    source: "ppm",
    created: "2026-11-12T00:00:00Z",
    updated: "2026-11-12T00:00:00Z",
    archived: f.archived,
    body: f.body ?? `body of ${id}`,
  }));
}

interface Call { model: string; texts: string[]; kind: EmbedKind }

/** Records every call; tracks the largest number of calls in flight at once. */
function fakeEmbedder(model: string, calls: Call[], opts: { delayMs?: number } = {}) {
  let inFlight = 0;
  const stats = { maxInFlight: 0 };
  const embedder: Embedder = {
    model,
    async embed(texts: string[], kind: EmbedKind) {
      calls.push({ model, texts: [...texts], kind });
      inFlight++;
      stats.maxInFlight = Math.max(stats.maxInFlight, inFlight);
      try {
        await new Promise((r) => setTimeout(r, opts.delayMs ?? 1));
        return texts.map((t) => new Float32Array([t.length, 1, 2]));
      } finally {
        inFlight--;
      }
    },
  };
  return { embedder, stats };
}

const failing = (model: string, message: string): Embedder => ({
  model,
  embed: async () => {
    throw new Error(message);
  },
});

const hanging = (model: string): Embedder => ({
  model,
  embed: () => new Promise<Float32Array[]>(() => {}),
});

const KEYS = [KEY, GLOBAL_MEMORY_KEY];

describe("embed queue", () => {
  test("embeds every memory missing a vector as passages, in batches of at most 16", async () => {
    const { index, dir, globalDir, reconcileAll } = fresh();
    for (let i = 0; i < 20; i++) writeMemory(dir, `p${i}`);
    for (let i = 0; i < 3; i++) writeMemory(globalDir, `g${i}`);
    writeMemory(dir, "special", { name: "Deploy rule", description: "how we ship", body: "only when idle" });
    await reconcileAll();

    const calls: Call[] = [];
    const { embedder } = fakeEmbedder("fake:a", calls);
    const queue = api().createEmbedQueue({ index: () => index, embedder: () => embedder });
    await queue.kick(KEY);

    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const c of calls) {
      expect(c.kind).toBe("passage");
      expect(c.texts.length).toBeGreaterThan(0);
      expect(c.texts.length).toBeLessThanOrEqual(16);
    }
    const texts = calls.flatMap((c) => c.texts);
    expect(texts.length).toBe(24);
    const special = texts.find((t) => t.includes("Deploy rule"));
    expect(special).toBeDefined();
    expect(special).toContain("how we ship");
    expect(special).toContain("only when idle");

    const rows = index.list(KEYS);
    const vectors = index.getVectors(KEYS, "fake:a");
    expect(vectors.length).toBe(24);
    const revisions = new Map(rows.map((r) => [`${r.projectKey}/${r.id}`, r.revision]));
    for (const v of vectors) expect(v.revision).toBe(revisions.get(`${v.projectKey}/${v.id}`)!);

    expect(queue.status(KEY)).toEqual({ model: "fake:a", vectors: 24, total: 24, running: false, reason: null });
  });

  test("skips memories whose vector is current and recomputes a stale revision only", async () => {
    const { index, dir, reconcileAll } = fresh();
    for (let i = 0; i < 5; i++) writeMemory(dir, `m${i}`);
    await reconcileAll();
    const calls: Call[] = [];
    const { embedder } = fakeEmbedder("fake:a", calls);
    const queue = api().createEmbedQueue({ index: () => index, embedder: () => embedder });
    await queue.kick(KEY);
    expect(calls.flatMap((c) => c.texts).length).toBe(5);

    calls.length = 0;
    await queue.kick(KEY);
    expect(calls.length).toBe(0);

    writeMemory(dir, "m2", { body: "a much longer, rewritten body for m2" });
    await reconcileAll();
    const newRevision = index.list([KEY]).find((r) => r.id === "m2")!.revision;
    calls.length = 0;
    await queue.kick(KEY);
    const texts = calls.flatMap((c) => c.texts);
    expect(texts.length).toBe(1);
    expect(texts[0]).toContain("a much longer, rewritten body for m2");
    const v = index.getVectors([KEY], "fake:a").find((x) => x.id === "m2")!;
    expect(v.revision).toBe(newRevision);
    expect(queue.status(KEY)).toMatchObject({ vectors: 5, total: 5 });
  });

  test("leaves archived memories out of the work and the counts", async () => {
    const { index, dir, reconcileAll } = fresh();
    writeMemory(dir, "live");
    writeMemory(dir, "old", { archived: true });
    await reconcileAll();
    const calls: Call[] = [];
    const { embedder } = fakeEmbedder("fake:a", calls);
    const queue = api().createEmbedQueue({ index: () => index, embedder: () => embedder });
    await queue.kick(KEY);
    expect(calls.flatMap((c) => c.texts).length).toBe(1);
    expect(index.getVectors([KEY], "fake:a").map((v) => v.id)).toEqual(["live"]);
    expect(queue.status(KEY)).toMatchObject({ vectors: 1, total: 1 });
  });

  test("a kick without a project covers every project folder and the global one", async () => {
    const { index, dir, otherDir, globalDir, reconcileAll } = fresh();
    writeMemory(dir, "a");
    writeMemory(otherDir, "b");
    writeMemory(globalDir, "c");
    await reconcileAll();
    const calls: Call[] = [];
    const { embedder } = fakeEmbedder("fake:a", calls);
    const queue = api().createEmbedQueue({ index: () => index, embedder: () => embedder });
    await queue.kick();
    const all = [KEY, OTHER_KEY, GLOBAL_MEMORY_KEY];
    expect(index.getVectors(all, "fake:a").map((v) => v.id).sort()).toEqual(["a", "b", "c"]);
    expect(queue.status()).toMatchObject({ vectors: 3, total: 3 });
    // A project's count is its own memories plus the global ones.
    expect(queue.status(OTHER_KEY)).toMatchObject({ vectors: 2, total: 2 });
  });

  test("with no embedder nothing is embedded and the status says why", async () => {
    const { index, dir, reconcileAll } = fresh();
    writeMemory(dir, "a");
    writeMemory(dir, "b");
    await reconcileAll();
    const queue = api().createEmbedQueue({ index: () => index, embedder: () => null });
    await queue.kick(KEY);
    const s = queue.status(KEY);
    expect(s.model).toBeNull();
    expect(s.vectors).toBe(0);
    expect(s.total).toBe(2);
    expect(s.running).toBe(false);
    expect(typeof s.reason).toBe("string");
    expect(s.reason.length).toBeGreaterThan(0);
  });

  test("a failing embedder records its error as the reason and is retried on the next kick", async () => {
    const { index, dir, reconcileAll } = fresh();
    for (let i = 0; i < 3; i++) writeMemory(dir, `m${i}`);
    await reconcileAll();
    const calls: Call[] = [];
    const { embedder: good } = fakeEmbedder("fake:a", calls);
    let current: Embedder = failing("fake:a", "embedding host exited with code 1");
    const changes: any[] = [];
    const queue = api().createEmbedQueue({
      index: () => index,
      embedder: () => current,
      onChange: (s: unknown) => changes.push(s),
    });

    await queue.kick(KEY);
    let s = queue.status(KEY);
    expect(s.reason).toContain("embedding host exited with code 1");
    expect(s.running).toBe(false);
    expect(s.vectors).toBe(0);
    expect(index.getVectors([KEY], "fake:a").length).toBe(0);
    expect(changes.length).toBeGreaterThan(0);

    current = good;
    await queue.kick(KEY);
    s = queue.status(KEY);
    expect(s.reason).toBeNull();
    expect(s.vectors).toBe(3);
    expect(calls.flatMap((c) => c.texts).length).toBe(3);
  });

  test("a hung embedder times out as a failure and the next kick still runs", async () => {
    const { index, dir, reconcileAll } = fresh();
    writeMemory(dir, "a");
    await reconcileAll();
    const calls: Call[] = [];
    const { embedder: good } = fakeEmbedder("fake:a", calls);
    let current: Embedder = hanging("fake:a");
    const queue = api().createEmbedQueue({ index: () => index, embedder: () => current, timeoutMs: 50 });

    const started = Date.now();
    await queue.kick(KEY);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(queue.status(KEY).reason).toMatch(/timed out/i);
    expect(queue.status(KEY).running).toBe(false);

    current = good;
    await queue.kick(KEY);
    expect(queue.status(KEY)).toMatchObject({ vectors: 1, total: 1, reason: null });
  });

  test("the default per-batch timeout is 60 s", () => {
    expect(api().EMBED_BATCH_TIMEOUT_MS).toBe(60_000);
  });

  test("an embedder answering the wrong number of vectors is a failure, nothing stored", async () => {
    const { index, dir, reconcileAll } = fresh();
    writeMemory(dir, "a");
    writeMemory(dir, "b");
    await reconcileAll();
    const short: Embedder = { model: "fake:a", embed: async () => [new Float32Array([1, 2, 3])] };
    const queue = api().createEmbedQueue({ index: () => index, embedder: () => short });
    await queue.kick(KEY);
    expect(queue.status(KEY).reason).toBeTruthy();
    expect(index.getVectors([KEY], "fake:a").length).toBe(0);
  });

  test("batches run one at a time, and overlapping kicks never embed a memory twice", async () => {
    const { index, dir, reconcileAll } = fresh();
    for (let i = 0; i < 40; i++) writeMemory(dir, `m${i}`);
    await reconcileAll();
    const calls: Call[] = [];
    const { embedder, stats } = fakeEmbedder("fake:a", calls, { delayMs: 5 });
    const seen: boolean[] = [];
    const queue = api().createEmbedQueue({
      index: () => index,
      embedder: () => embedder,
      onChange: (s: { running: boolean }) => seen.push(s.running),
    });
    await Promise.all([queue.kick(KEY), queue.kick(KEY), queue.kick()]);
    expect(stats.maxInFlight).toBe(1);
    const texts = calls.flatMap((c) => c.texts);
    expect(texts.length).toBe(40);
    expect(new Set(texts).size).toBe(40);
    expect(seen).toContain(true);
    expect(seen[seen.length - 1]).toBe(false);
    expect(queue.status(KEY)).toMatchObject({ vectors: 40, total: 40, running: false });
  });

  test("a model change deletes the old model's vectors and recomputes with the new one only", async () => {
    const { index, dir, globalDir, reconcileAll } = fresh();
    for (let i = 0; i < 4; i++) writeMemory(dir, `m${i}`);
    writeMemory(globalDir, "g");
    await reconcileAll();
    const calls: Call[] = [];
    let current: Embedder = fakeEmbedder("fake:a", calls).embedder;
    const queue = api().createEmbedQueue({ index: () => index, embedder: () => current });
    await queue.kick(KEY);
    expect(index.getVectors(KEYS, "fake:a").length).toBe(5);

    calls.length = 0;
    current = fakeEmbedder("fake:b", calls).embedder;
    await queue.kick(KEY);
    expect(index.getVectors(KEYS, "fake:a").length).toBe(0);
    expect(index.getVectors(KEYS, "fake:b").length).toBe(5);
    expect(calls.every((c) => c.model === "fake:b")).toBe(true);
    expect(calls.flatMap((c) => c.texts).length).toBe(5);
    expect(queue.status(KEY)).toMatchObject({ model: "fake:b", vectors: 5, total: 5 });
  });

  test("a model change is noticed across a restart (a new queue over the same index)", async () => {
    const { index, dir, reconcileAll } = fresh();
    writeMemory(dir, "a");
    writeMemory(dir, "b");
    await reconcileAll();
    const calls: Call[] = [];
    const first = api().createEmbedQueue({ index: () => index, embedder: () => fakeEmbedder("fake:a", calls).embedder });
    await first.kick(KEY);
    expect(index.getVectors([KEY], "fake:a").length).toBe(2);

    const second = api().createEmbedQueue({ index: () => index, embedder: () => fakeEmbedder("fake:b", calls).embedder });
    await second.kick(KEY);
    expect(index.getVectors([KEY], "fake:a").length).toBe(0);
    expect(index.getVectors([KEY], "fake:b").length).toBe(2);
  });
});
