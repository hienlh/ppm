/**
 * Hybrid memory search: full-text scores fused with cosine similarity of current-model vectors
 * as `max(v, f) + 0.3 × min(v, f)`, text only when the query cannot be embedded. Each test gets
 * its own PPM_HOME (and so its own index.db) under one temp dir; nothing touches ~/.ppm.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetPpmDir } from "../../../src/services/ppm-dir.ts";
import { serializeMemoryFile } from "../../../src/services/memory/memory-file.ts";
import { closeMemoryIndex, getMemoryIndex, GLOBAL_MEMORY_KEY } from "../../../src/services/memory/memory-index.ts";
import { ensureProjectMemoryDir, globalMemoryDir, projectMemoryKey } from "../../../src/services/memory/memory-paths.ts";
import type { Embedder, EmbedKind } from "../../../src/services/memory/embedding/embedder.ts";

const originalPpmHome = process.env.PPM_HOME;
const home = mkdtempSync(join(tmpdir(), "ppm-memory-search-"));

// Loaded dynamically so a missing module fails the assertions below, not the file's load.
const MODULE = "../../../src/services/memory/memory-search.ts";
let mod: any = null;

beforeAll(async () => {
  mod = await import(MODULE).catch(() => null);
});

let seq = 0;
beforeEach(() => {
  process.env.PPM_HOME = join(home, `case-${++seq}`);
  mkdirSync(process.env.PPM_HOME, { recursive: true });
  _resetPpmDir();
});

afterAll(() => {
  closeMemoryIndex();
  if (originalPpmHome === undefined) delete process.env.PPM_HOME;
  else process.env.PPM_HOME = originalPpmHome;
  _resetPpmDir();
  rmSync(home, { recursive: true, force: true });
});

function search(opts: Record<string, unknown>, deps: Record<string, unknown>) {
  expect(mod).not.toBeNull();
  expect(typeof mod.search).toBe("function");
  return mod.search(opts, deps);
}

const PROJECT = "/work/demo-project";
const MODEL = "fake:model-a";

interface Fields { name?: string; description?: string; body?: string; archived?: boolean; source?: "ppm" | "claude" }

function writeMemory(dir: string, id: string, f: Fields = {}): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.md`), serializeMemoryFile({
    name: f.name ?? id,
    description: f.description ?? "",
    type: "project",
    source: f.source ?? "ppm",
    created: "2026-11-12T00:00:00Z",
    updated: "2026-11-12T00:00:00Z",
    archived: f.archived,
    body: f.body ?? "",
  }));
}

/** Writes project and global memories, reconciles both folders, returns the keys. */
async function seed(project: Record<string, Fields>, global: Record<string, Fields> = {}) {
  const projectDir = await ensureProjectMemoryDir(PROJECT);
  const key = projectMemoryKey(PROJECT);
  for (const [id, f] of Object.entries(project)) writeMemory(projectDir, id, f);
  for (const [id, f] of Object.entries(global)) writeMemory(globalMemoryDir(), id, f);
  const index = getMemoryIndex();
  await index.reconcile(projectDir, "project", key);
  await index.reconcile(globalMemoryDir(), "global", GLOBAL_MEMORY_KEY);
  return { key, index };
}

/** Stores a vector for one memory at its current revision (or the one given). */
function putVec(projectKey: string, id: string, vec: number[], model = MODEL, revision?: string): void {
  const index = getMemoryIndex();
  const row = index.list([projectKey], { includeArchived: true }).find((r) => r.id === id);
  expect(row).toBeDefined();
  index.putVector({
    id,
    scope: row!.scope,
    projectKey,
    model,
    revision: revision ?? row!.revision,
    vector: new Float32Array(vec),
  });
}

function fakeEmbedder(queryVec: number[], model = MODEL) {
  const calls: { texts: string[]; kind: EmbedKind }[] = [];
  const embedder: Embedder = {
    model,
    async embed(texts, kind) {
      calls.push({ texts, kind });
      return texts.map(() => new Float32Array(queryVec));
    },
  };
  return { embedder, calls };
}

const fuse = (v: number, f: number) => Math.max(v, f) + 0.3 * Math.min(v, f);
const noEmbedder = { embedder: () => null };

describe("text only", () => {
  test("no embedder: mode text, a reason, scores are the text scores", async () => {
    const { key, index } = await seed({
      a: { name: "deploy guard", body: "the deploy waits for idle sessions" },
      b: { name: "notes", body: "deploy once" },
      c: { name: "unrelated", body: "nothing here" },
    });
    const res = await search({ projectPath: PROJECT, query: "deploy idle" }, noEmbedder);
    expect(res.mode).toBe("text");
    expect(typeof res.reason).toBe("string");
    expect(res.reason.length).toBeGreaterThan(0);

    const expected = index.textSearch("deploy idle", [key, GLOBAL_MEMORY_KEY], 50);
    expect(res.results.map((r: any) => r.id)).toEqual(expected.map((h) => h.id));
    expect(res.results.map((r: any) => r.id)).not.toContain("c");
    for (const r of res.results) {
      const hit = expected.find((h) => h.id === r.id)!;
      expect(r.score).toBeCloseTo(hit.score, 6);
    }
  });

  test("a result carries id, scope, name, description, source and score", async () => {
    await seed({ a: { name: "Deploy guard", description: "waits for idle", body: "deploy", source: "claude" } });
    const res = await search({ projectPath: PROJECT, query: "deploy" }, noEmbedder);
    expect(res.results).toHaveLength(1);
    expect(res.results[0]).toEqual({
      id: "a", scope: "project", name: "Deploy guard", description: "waits for idle", source: "claude", score: 1, match: "strong",
    });
  });
});

describe("hybrid", () => {
  test("scores max(v,f) + 0.3·min(v,f), a missing side counting 0; strong matches rank first", async () => {
    const { key, index } = await seed({
      a: { name: "alpha", body: "alpha alpha alpha" },
      b: { name: "beta", body: "alpha beta" },
      c: { name: "gamma", body: "gamma only" },
      d: { name: "delta", body: "alpha once in a much longer body of words that dilute it a lot" },
    });
    // q = (1,0,0): a's cosine 0, b's 0.6, c's 0.8 (not unit length on purpose), d has no vector.
    putVec(key, "a", [0, 1, 0]);
    putVec(key, "b", [3, 4, 0]);
    putVec(key, "c", [8, 6, 0]);
    const { embedder, calls } = fakeEmbedder([1, 0, 0]);
    const res = await search({ projectPath: PROJECT, query: "alpha" }, { embedder: () => embedder });

    expect(res.mode).toBe("hybrid");
    expect(res.reason).toBeUndefined();
    expect(calls).toEqual([{ texts: ["alpha"], kind: "query" }]);

    const f = new Map(index.textSearch("alpha", [key, GLOBAL_MEMORY_KEY], 50).map((h) => [h.id, h.score]));
    const v = new Map([["a", 0], ["b", 0.6], ["c", 0.8]]);
    // c holds no query word and, among 3 vectors, cannot stand out by meaning: weak, so it comes
    // after every memory that holds "alpha", whatever its score.
    const strong = new Set(["a", "b", "d"]);
    const expected = ["a", "b", "c", "d"]
      .map((id) => ({ id, score: fuse(v.get(id) ?? 0, f.get(id) ?? 0), strong: strong.has(id) }))
      .sort((x, y) => Number(y.strong) - Number(x.strong) || y.score - x.score);

    expect(res.results.map((r: any) => r.id)).toEqual(expected.map((e) => e.id));
    for (const e of expected) {
      const r = res.results.find((x: any) => x.id === e.id);
      expect(r.score).toBeCloseTo(e.score, 5);
      expect(r.match).toBe(e.strong ? "strong" : "weak");
    }
  });

  test("a memory found only by meaning, sharing no word with the query, is returned", async () => {
    const { key } = await seed({
      ocean: { name: "ocean", body: "waves and tides" },
      other: { name: "other", body: "compiler flags" },
    });
    putVec(key, "ocean", [0.9, 0.1, 0]);
    putVec(key, "other", [0, 0, 1]);
    const { embedder } = fakeEmbedder([1, 0, 0]);

    const text = await search({ projectPath: PROJECT, query: "sea water" }, noEmbedder);
    expect(text.results).toEqual([]);

    const res = await search({ projectPath: PROJECT, query: "sea water" }, { embedder: () => embedder });
    expect(res.mode).toBe("hybrid");
    expect(res.results[0].id).toBe("ocean");
    const cos = 0.9 / Math.hypot(0.9, 0.1);
    expect(res.results[0].score).toBeCloseTo(fuse(cos, 0), 5);
  });

  test("vectors of another model are never compared", async () => {
    const { key, index } = await seed({
      x: { name: "x", body: "kitchen" },
      y: { name: "y", body: "garden kitchen" },
    });
    putVec(key, "x", [1, 0, 0], "fake:model-b");
    putVec(key, "y", [0, 1, 0], MODEL);
    const { embedder } = fakeEmbedder([1, 0, 0]);
    const res = await search({ projectPath: PROJECT, query: "kitchen" }, { embedder: () => embedder });

    expect(res.mode).toBe("hybrid");
    const f = new Map(index.textSearch("kitchen", [key], 50).map((h) => [h.id, h.score]));
    // x's only vector is model-b's: it counts as no vector, so its score is its text score alone.
    expect(res.results.find((r: any) => r.id === "x").score).toBeCloseTo(fuse(0, f.get("x")!), 5);
    expect(res.results.find((r: any) => r.id === "y").score).toBeCloseTo(fuse(0, f.get("y")!), 5);

    // A memory whose only vector is another model's and shares no word is not found.
    const none = await search({ projectPath: PROJECT, query: "unmatched" }, { embedder: () => embedder });
    expect(none.results.map((r: any) => r.id)).not.toContain("x");
  });

  test("a vector of an older revision is not current and is ignored", async () => {
    const { key } = await seed({ s: { name: "s", body: "nothing in common" } });
    putVec(key, "s", [1, 0, 0], MODEL, "000000000000");
    const { embedder } = fakeEmbedder([1, 0, 0]);
    const res = await search({ projectPath: PROJECT, query: "query words" }, { embedder: () => embedder });
    expect(res.mode).toBe("hybrid");
    expect(res.results.map((r: any) => r.id)).not.toContain("s");
  });
});

describe("falling back to text", () => {
  test("an embedder that throws gives text mode with the reason", async () => {
    await seed({ a: { name: "a", body: "deploy" } });
    const embedder: Embedder = { model: MODEL, embed: async () => { throw new Error("host died: boom"); } };
    const res = await search({ projectPath: PROJECT, query: "deploy" }, { embedder: () => embedder });
    expect(res.mode).toBe("text");
    expect(res.reason).toContain("host died: boom");
    expect(res.results.map((r: any) => r.id)).toEqual(["a"]);
    expect(res.results[0].score).toBe(1);
  });

  test("an embedder slower than the timeout gives text mode, without waiting for it", async () => {
    const { key } = await seed({ a: { name: "a", body: "deploy" }, b: { name: "b", body: "other" } });
    putVec(key, "b", [1, 0, 0]);
    const embedder: Embedder = {
      model: MODEL,
      embed: () => new Promise((resolve) => setTimeout(() => resolve([new Float32Array([1, 0, 0])]), 2_000)),
    };
    const started = performance.now();
    const res = await search({ projectPath: PROJECT, query: "deploy" }, { embedder: () => embedder, timeoutMs: 50 });
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(res.mode).toBe("text");
    expect(res.reason).toMatch(/time/i);
    expect(res.results.map((r: any) => r.id)).toEqual(["a"]);
  });

  test("an embedder that never answers is cut at the default 3 s", async () => {
    await seed({ a: { name: "a", body: "deploy" } });
    const embedder: Embedder = { model: MODEL, embed: () => new Promise(() => {}) };
    const started = performance.now();
    const res = await search({ projectPath: PROJECT, query: "deploy" }, { embedder: () => embedder });
    const took = performance.now() - started;
    expect(took).toBeGreaterThanOrEqual(2_900);
    expect(took).toBeLessThan(4_500);
    expect(res.mode).toBe("text");
    expect(res.reason).toMatch(/time/i);
  }, 10_000);
});

describe("filters", () => {
  test("archived memories are left out in both modes", async () => {
    const { key } = await seed({
      live: { name: "live", body: "deploy" },
      gone: { name: "gone", body: "deploy deploy", archived: true },
    });
    putVec(key, "live", [0, 1, 0]);
    putVec(key, "gone", [1, 0, 0]);
    const { embedder } = fakeEmbedder([1, 0, 0]);

    const text = await search({ projectPath: PROJECT, query: "deploy" }, noEmbedder);
    expect(text.results.map((r: any) => r.id)).toEqual(["live"]);
    const hybrid = await search({ projectPath: PROJECT, query: "deploy" }, { embedder: () => embedder });
    expect(hybrid.mode).toBe("hybrid");
    expect(hybrid.results.map((r: any) => r.id)).toEqual(["live"]);
  });

  test("scope picks project, global or both; no project means global only", async () => {
    const { key } = await seed(
      { p: { name: "p", body: "shared word" } },
      { g: { name: "g", body: "shared word" } },
    );
    putVec(key, "p", [1, 0, 0]);
    putVec(GLOBAL_MEMORY_KEY, "g", [1, 0, 0]);
    const { embedder } = fakeEmbedder([1, 0, 0]);

    for (const deps of [noEmbedder, { embedder: () => embedder }]) {
      const pick = async (opts: Record<string, unknown>) =>
        (await search({ query: "shared", ...opts }, deps)).results.map((r: any) => `${r.scope}:${r.id}`).sort();
      expect(await pick({ projectPath: PROJECT, scope: "project" })).toEqual(["project:p"]);
      expect(await pick({ projectPath: PROJECT, scope: "global" })).toEqual(["global:g"]);
      expect(await pick({ projectPath: PROJECT, scope: "all" })).toEqual(["global:g", "project:p"]);
      expect(await pick({ projectPath: PROJECT })).toEqual(["global:g", "project:p"]);
      expect(await pick({})).toEqual(["global:g"]);
    }
  });

  test("limit caps the results, keeping the best; the default is 10", async () => {
    const project: Record<string, Fields> = {};
    for (let i = 0; i < 12; i++) project[`m${String(i).padStart(2, "0")}`] = { name: `m${i}`, body: `topic ${"filler ".repeat(i)}` };
    await seed(project);

    const all = await search({ projectPath: PROJECT, query: "topic", limit: 50 }, noEmbedder);
    expect(all.results).toHaveLength(12);
    const two = await search({ projectPath: PROJECT, query: "topic", limit: 2 }, noEmbedder);
    expect(two.results.map((r: any) => r.id)).toEqual(all.results.slice(0, 2).map((r: any) => r.id));
    const byDefault = await search({ projectPath: PROJECT, query: "topic" }, noEmbedder);
    expect(byDefault.results).toHaveLength(10);

    const key = projectMemoryKey(PROJECT);
    for (const id of Object.keys(project)) putVec(key, id, [1, 0, 0]);
    const { embedder } = fakeEmbedder([1, 0, 0]);
    const hybrid = await search({ projectPath: PROJECT, query: "topic", limit: 3 }, { embedder: () => embedder });
    expect(hybrid.mode).toBe("hybrid");
    expect(hybrid.results).toHaveLength(3);
  });
});
