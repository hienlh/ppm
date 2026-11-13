/**
 * Telling an answer from "whatever ranked next" (2026-11-12): searching "zebra teapot" in the real
 * store answered three unrelated memories scored 1.24, 1.17 and 1.15, against 1.23 for a real hit,
 * because the top text hit is always 1.0 and e5 similarities sit in a narrow band. Each result is
 * now labelled `match: "strong" | "weak"` from the query's rarity-weighted words a memory holds and
 * from how far its similarity stands above the store's, and `memory_search` lists only strong ones,
 * or says that nothing matches clearly.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetPpmDir } from "../../../src/services/ppm-dir.ts";
import { serializeMemoryFile } from "../../../src/services/memory/memory-file.ts";
import { closeMemoryIndex, getMemoryIndex } from "../../../src/services/memory/memory-index.ts";
import { ensureProjectMemoryDir, projectMemoryKey } from "../../../src/services/memory/memory-paths.ts";
import { search, STRONG_COVERAGE } from "../../../src/services/memory/memory-search.ts";
import { createMemoryTools } from "../../../src/services/tab-tools-mcp/memory-tools.ts";
import type { Embedder } from "../../../src/services/memory/embedding/embedder.ts";

const originalPpmHome = process.env.PPM_HOME;
const home = mkdtempSync(join(tmpdir(), "ppm-memory-match-"));
let seq = 0;
beforeEach(() => {
  closeMemoryIndex();
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

const PROJECT = "/work/match-project";
const MODEL = "fake:match";
const DIMS = 16;

/** Thirty memories about ordinary project things, plus whatever a test adds. */
async function seed(extra: Record<string, string> = {}) {
  const dir = await ensureProjectMemoryDir(PROJECT);
  const key = projectMemoryKey(PROJECT);
  const bodies: Record<string, string> = {};
  for (let i = 0; i < 30; i++) bodies[`m${i}`] = `the server and the build for release ${i} in the project, deploy notes ${i}`;
  Object.assign(bodies, extra);
  for (const [id, body] of Object.entries(bodies)) {
    writeFileSync(join(dir, `${id}.md`), serializeMemoryFile({
      name: id, description: "", type: "project", source: "ppm",
      created: "2026-11-12T00:00:00Z", updated: "2026-11-12T00:00:00Z", body,
    }));
  }
  const index = getMemoryIndex();
  await index.reconcile(dir, "project", key);
  return { key, index, ids: Object.keys(bodies) };
}

/** A deterministic vector per memory: a shared direction plus a little noise, so similarities bunch up like e5's. */
function vecFor(seed: number, lift: number[] = []): Float32Array {
  const v = new Float32Array(DIMS);
  let x = seed * 9301 + 49297;
  for (let i = 0; i < DIMS; i++) {
    x = (x * 9301 + 49297) % 233280;
    v[i] = 1 + 0.15 * (x / 233280 - 0.5) + (lift[i] ?? 0);
  }
  return v;
}

function embedder(query: Float32Array): Embedder {
  return { model: MODEL, async embed(texts) { return texts.map(() => query); } } as Embedder;
}

async function withVectors(standOut?: { id: string; lift: number[] }) {
  const s = await seed(standOut ? { [standOut.id]: "nothing in common with the question" } : {});
  s.ids.forEach((id, i) => {
    const row = s.index.list([s.key]).find((r) => r.id === id)!;
    s.index.putVector({ id, scope: "project", projectKey: s.key, model: MODEL, revision: row.revision,
      vector: id === standOut?.id ? vecFor(i, standOut.lift) : vecFor(i) });
  });
  return s;
}

describe("match labels", () => {
  test("a query of words no memory holds, with nothing standing out by meaning, answers only weak results", async () => {
    await withVectors();
    const res = await search({ projectPath: PROJECT, query: "zebra teapot" }, { embedder: () => embedder(vecFor(999)) });
    expect(res.mode).toBe("hybrid");
    expect(res.results.length).toBeGreaterThan(0);
    expect(res.results.every((r) => r.match === "weak")).toBe(true);
  });

  test("holding only the common words of a query is weak; holding its rare word is strong", async () => {
    await seed({ rare: "the wayland capture notes" });
    const res = await search({ projectPath: PROJECT, query: "the wayland" }, { embedder: () => null });
    expect(res.results[0]).toMatchObject({ id: "rare", match: "strong" });
    const common = res.results.filter((r) => r.id !== "rare");
    expect(common.length).toBeGreaterThan(0);
    expect(common.every((r) => r.match === "weak")).toBe(true);
  });

  test("a memory the store holds the query's words for is strong in text mode too", async () => {
    await seed({ hit: "payroll database certificate bundle" });
    const res = await search({ projectPath: PROJECT, query: "payroll certificate" }, { embedder: () => null });
    expect(res.mode).toBe("text");
    expect(res.results).toHaveLength(1);
    expect(res.results[0]).toMatchObject({ id: "hit", match: "strong" });
  });

  test("a memory far above the store's similarity is strong by meaning alone, and comes first", async () => {
    const lift = Array.from({ length: DIMS }, (_, i) => (i < 4 ? 3 : 0));
    await withVectors({ id: "meaning", lift });
    const query = vecFor(0, lift);
    const res = await search({ projectPath: PROJECT, query: "zebra teapot" }, { embedder: () => embedder(query) });
    expect(res.results[0]).toMatchObject({ id: "meaning", match: "strong" });
    expect(res.results.slice(1).every((r) => r.match === "weak")).toBe(true);
  });

  test("with too few vectors to tell, meaning alone never makes a strong match", async () => {
    const dir = await ensureProjectMemoryDir(PROJECT);
    const key = projectMemoryKey(PROJECT);
    for (const id of ["a", "b", "c"]) {
      writeFileSync(join(dir, `${id}.md`), serializeMemoryFile({ name: id, description: "", type: "project", source: "ppm",
        created: "2026-11-12T00:00:00Z", updated: "2026-11-12T00:00:00Z", body: "unrelated text" }));
    }
    const index = getMemoryIndex();
    await index.reconcile(dir, "project", key);
    for (const [i, id] of ["a", "b", "c"].entries()) {
      const row = index.list([key]).find((r) => r.id === id)!;
      index.putVector({ id, scope: "project", projectKey: key, model: MODEL, revision: row.revision, vector: vecFor(i, i === 0 ? [9, 9, 9] : []) });
    }
    const res = await search({ projectPath: PROJECT, query: "zebra" }, { embedder: () => embedder(vecFor(0, [9, 9, 9])) });
    expect(res.results.every((r) => r.match === "weak")).toBe(true);
  });

  test("coverage weighs a word by rarity: the common word alone stays under the strong line", async () => {
    const { key, index } = await seed({ rare: "the wayland capture notes" });
    const byId = new Map(index.coverage("the wayland", [key]).map((c) => [c.id, c.coverage]));
    expect(byId.get("rare")).toBeCloseTo(1, 5);
    expect(byId.get("m0")!).toBeLessThan(STRONG_COVERAGE);
    expect(byId.get("m0")!).toBeGreaterThan(0);
  });
});

describe("memory_search output", () => {
  const binding = { sessionId: "s", projectPath: PROJECT };
  const textOf = (r: any) => r.content.map((c: any) => c.text).join("\n");

  test("nothing strong: says no memory clearly matches and lists at most three, as probably unrelated", async () => {
    await withVectors();
    const tools = createMemoryTools({ embedder: () => embedder(vecFor(999)), ensureSynced: async () => undefined, written: async () => undefined });
    const out = textOf(await tools.call(binding, "memory_search", { query: "zebra teapot" }));
    expect(out).toContain('No memory clearly matches "zebra teapot"');
    expect(out).toContain("probably unrelated");
    expect(out.split("\n").filter((l) => l.startsWith("- ")).length).toBe(3);
  });

  test("strong results are listed and weak ones left out", async () => {
    await seed({ rare: "the wayland capture notes" });
    const tools = createMemoryTools({ embedder: () => null, ensureSynced: async () => undefined, written: async () => undefined });
    const out = textOf(await tools.call(binding, "memory_search", { query: "the wayland" }));
    const rows = out.split("\n").filter((l) => l.startsWith("- "));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("rare");
    expect(out).not.toContain("clearly matches");
  });
});
