import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { _resetPpmDir } from "../../../src/services/ppm-dir.ts";
import { importAntigravity } from "../../../src/services/memory/import-antigravity.ts";
import { MEMORY_TYPES } from "../../../src/services/memory/memory-types.ts";

const originalPpmHome = process.env.PPM_HOME;
let root: string;
let home: string;
let knowledge: string;

function put(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function item(folder: string, metadata: unknown, artifacts: Record<string, string> = {}) {
  const dir = join(knowledge, folder);
  mkdirSync(dir, { recursive: true });
  if (metadata !== undefined) {
    put(join(dir, "metadata.json"), typeof metadata === "string" ? metadata : JSON.stringify(metadata));
  }
  put(join(dir, "timestamps.json"), JSON.stringify({ created: "2026-11-01T00:00:00Z" }));
  for (const [rel, text] of Object.entries(artifacts)) put(join(dir, "artifacts", rel), text);
}

/** Every file under a directory with its size, mtime and content, to prove nothing was written. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      const st = statSync(p);
      out[relative(dir, p)] = `${st.size}:${st.mtimeMs}:${readFileSync(p, "utf8")}`;
    }
  };
  walk(dir);
  return out;
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "ppm-import-agy-"));
  process.env.PPM_HOME = join(root, "ppm");
  _resetPpmDir();
  home = join(root, "home");
  knowledge = join(home, ".gemini", "antigravity", "knowledge");
  mkdirSync(knowledge, { recursive: true });

  put(join(knowledge, "knowledge.lock"), "locked");
  put(join(knowledge, "stray.md"), "# not an item");

  item("deploy-flow", { title: "Deploy flow", summary: "How PPM is deployed", tags: ["x"] }, {
    "z-last.md": "Z content",
    "a-first.md": "A content",
    "nested/deeper/b-middle.md": "B content",
    "notes.txt": "TXT must be ignored",
  });
  item("no-summary", { title: "Only a title" }, { "one.md": "One" });
  item("no-artifacts", { title: "Empty item", summary: "Nothing inside" });
  item("big", { title: "Big item", summary: "Too large" }, { "big.md": "x".repeat(100 * 1024) });
  item("big-multibyte", { title: "Big multibyte", summary: "Vietnamese" }, { "vi.md": "đường ".repeat(20 * 1024) });

  item("nometa", undefined, { "a.md": "A" });
  item("brokenjson", "{ not json", { "a.md": "A" });
  item("notitle", { summary: "No title here" }, { "a.md": "A" });
  item("emptytitle", { title: "   ", summary: "Blank" }, { "a.md": "A" });
  item("arraymeta", ["title"], { "a.md": "A" });
});

afterAll(() => {
  if (originalPpmHome === undefined) delete process.env.PPM_HOME;
  else process.env.PPM_HOME = originalPpmHome;
  _resetPpmDir();
  rmSync(root, { recursive: true, force: true });
});

describe("importAntigravity", () => {
  it("imports one global memory per knowledge item, named after its folder", async () => {
    const res = await importAntigravity("/some/project", { antigravityHome: home });
    expect(res.error).toBeUndefined();
    const ids = res.items.map((m) => m.id).sort();
    expect(ids).toEqual(["agy-big", "agy-big-multibyte", "agy-deploy-flow", "agy-no-artifacts", "agy-no-summary"]);
    for (const m of res.items) {
      expect(m.scope).toBe("global");
      expect(MEMORY_TYPES).toContain(m.type);
      expect(m.origin).toBe(join(knowledge, m.id.slice("agy-".length)));
      expect(m.originHash).toMatch(/^[0-9a-f]{16,}$/);
    }
  });

  it("takes name and description from title and summary", async () => {
    const res = await importAntigravity("/some/project", { antigravityHome: home });
    const deploy = res.items.find((m) => m.id === "agy-deploy-flow")!;
    expect(deploy.name).toBe("Deploy flow");
    expect(deploy.description).toBe("How PPM is deployed");
    const noSummary = res.items.find((m) => m.id === "agy-no-summary")!;
    expect(noSummary.name).toBe("Only a title");
    expect(noSummary.description).toBe("");
  });

  it("joins artifacts/**/*.md under ## <relative path> headings in sorted order, ignoring other files", async () => {
    const res = await importAntigravity("/some/project", { antigravityHome: home });
    const body = res.items.find((m) => m.id === "agy-deploy-flow")!.body;
    const a = body.indexOf("## a-first.md");
    const b = body.indexOf("## nested/deeper/b-middle.md");
    const z = body.indexOf("## z-last.md");
    expect(a).toBeGreaterThanOrEqual(0);
    expect(b).toBeGreaterThan(a);
    expect(z).toBeGreaterThan(b);
    expect(body.indexOf("A content")).toBeGreaterThan(a);
    expect(body.indexOf("A content")).toBeLessThan(b);
    expect(body.indexOf("B content")).toBeGreaterThan(b);
    expect(body.indexOf("B content")).toBeLessThan(z);
    expect(body.indexOf("Z content")).toBeGreaterThan(z);
    expect(body).not.toContain("TXT must be ignored");
    expect(body).not.toContain("notes.txt");

    const empty = res.items.find((m) => m.id === "agy-no-artifacts")!;
    expect(empty.body).toBe("");
  });

  it("caps the body at 64 KB without breaking a character", async () => {
    const res = await importAntigravity("/some/project", { antigravityHome: home });
    const big = res.items.find((m) => m.id === "agy-big")!;
    expect(big.body.startsWith("## big.md")).toBe(true);
    expect(Buffer.byteLength(big.body, "utf8")).toBeLessThanOrEqual(64 * 1024);
    expect(Buffer.byteLength(big.body, "utf8")).toBeGreaterThan(60 * 1024);

    const vi = res.items.find((m) => m.id === "agy-big-multibyte")!;
    expect(Buffer.byteLength(vi.body, "utf8")).toBeLessThanOrEqual(64 * 1024);
    expect(vi.body).not.toContain("�");
  });

  it("skips unrecognised items with a reason and still imports the others", async () => {
    const res = await importAntigravity("/some/project", { antigravityHome: home });
    const ids = res.items.map((m) => m.id);
    for (const bad of ["nometa", "brokenjson", "notitle", "emptytitle", "arraymeta"]) {
      expect(ids).not.toContain(`agy-${bad}`);
      const entry = res.skipped.find((s) => s.startsWith(`${bad}:`));
      expect(entry).toBeDefined();
      expect(entry!.length).toBeGreaterThan(`${bad}: `.length);
    }
    expect(res.skipped.find((s) => s.startsWith("nometa:"))).toMatch(/metadata\.json/);
    expect(res.skipped.find((s) => s.startsWith("brokenjson:"))).toMatch(/json/i);
    expect(res.skipped.find((s) => s.startsWith("notitle:"))).toMatch(/title/);
    expect(res.skipped).toHaveLength(5);
  });

  it("ignores knowledge.lock and stray files at the knowledge root", async () => {
    const res = await importAntigravity("/some/project", { antigravityHome: home });
    const all = [...res.items.map((m) => m.id), ...res.skipped].join("\n");
    expect(all).not.toContain("knowledge.lock");
    expect(all).not.toContain("stray");
  });

  it("is stable across runs and changes originHash when an artifact changes", async () => {
    const first = await importAntigravity("/some/project", { antigravityHome: home });
    const second = await importAntigravity("/some/project", { antigravityHome: home });
    expect(second.items).toEqual(first.items);

    const path = join(knowledge, "no-summary", "artifacts", "one.md");
    const before = first.items.find((m) => m.id === "agy-no-summary")!.originHash;
    writeFileSync(path, "One, edited");
    try {
      const third = await importAntigravity("/some/project", { antigravityHome: home });
      const after = third.items.find((m) => m.id === "agy-no-summary")!;
      expect(after.originHash).not.toBe(before);
      expect(after.body).toContain("One, edited");
      const deployBefore = first.items.find((m) => m.id === "agy-deploy-flow")!.originHash;
      expect(third.items.find((m) => m.id === "agy-deploy-flow")!.originHash).toBe(deployBefore);
    } finally {
      writeFileSync(path, "One");
    }
  });

  it("modifies nothing in the knowledge folder", async () => {
    const before = snapshot(knowledge);
    await importAntigravity("/some/project", { antigravityHome: home });
    expect(snapshot(knowledge)).toEqual(before);
  });

  it("returns zero items, no skips and no error when the knowledge folder is missing", async () => {
    const empty = join(root, "empty-home");
    mkdirSync(empty, { recursive: true });
    const res = await importAntigravity("/some/project", { antigravityHome: empty });
    expect(res).toEqual({ items: [], skipped: [] });
  });
});
