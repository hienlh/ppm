/**
 * The four memory tools on `ppm-tabs` (requirements 7.1–7.7, 10.3): `memory_search` answers
 * compact rows, `memory_read` a memory cut at 8,000 characters with the next offset,
 * `memory_write` creates or (at a matching revision) updates a PPM memory and reports the
 * redactions, `memory_forget` archives. Every failure is an MCP error result. The store is the
 * real one on a temp PPM_HOME; search, sync and the after-write hook are fakes that record.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetPpmDir } from "../../../src/services/ppm-dir.ts";
import { globalMemoryDir, projectMemoryDir } from "../../../src/services/memory/memory-paths.ts";
import { parseMemoryFile } from "../../../src/services/memory/memory-file.ts";
import { memoryStore } from "../../../src/services/memory/memory-store.ts";
import { redactSecrets } from "../../../src/services/memory/memory-redact.ts";
import { MEMORY_TYPES } from "../../../src/services/memory/memory-types.ts";
import { MEMORY_TOOLS } from "../../../src/shared/memory-tools.ts";
import { createTabToolsMcpHandler } from "../../../src/services/tab-tools-mcp/tab-tools-mcp-endpoint.ts";
import { createTabToolsMcpTokenStore } from "../../../src/services/tab-tools-mcp/tab-tools-mcp-tokens.ts";

const originalPpmHome = process.env.PPM_HOME;
const home = mkdtempSync(join(tmpdir(), "ppm-memory-tools-"));

// Loaded dynamically so a missing module fails the assertions below, not the file's load.
const TOOLS_MODULE = "../../../src/services/tab-tools-mcp/memory-tools.ts";
const DEFS_MODULE = "../../../src/services/tab-tools-mcp/memory-tool-definitions.ts";
let toolsMod: any = null;
let defsMod: any = null;

beforeAll(async () => {
  toolsMod = await import(TOOLS_MODULE).catch(() => null);
  defsMod = await import(DEFS_MODULE).catch(() => null);
});

let seq = 0;
let projectPath: string;
beforeEach(() => {
  process.env.PPM_HOME = join(home, `case-${++seq}`);
  _resetPpmDir();
  projectPath = join(home, `project-${seq}`);
});

afterAll(() => {
  if (originalPpmHome === undefined) delete process.env.PPM_HOME;
  else process.env.PPM_HOME = originalPpmHome;
  _resetPpmDir();
  rmSync(home, { recursive: true, force: true });
});

type Result = { content: Array<{ type: string; text: string }>; isError?: boolean };
const text = (r: Result) => r.content.map((c) => c.text).join("\n");

interface SearchRow { id: string; scope: "project" | "global"; name: string; description: string; source: string; score: number }

function setup(opts: {
  rows?: SearchRow[];
  mode?: "hybrid" | "text";
  reason?: string;
  searchThrows?: boolean;
  syncThrows?: boolean;
} = {}) {
  const searches: Array<{ opts: Record<string, unknown>; deps: Record<string, unknown> }> = [];
  const synced: string[] = [];
  const written: Array<[string, string | null]> = [];
  const embedder = () => null;
  expect(toolsMod).not.toBeNull();
  expect(typeof toolsMod.createMemoryTools).toBe("function");
  const tools = toolsMod.createMemoryTools({
    embedder,
    search: async (o: Record<string, unknown>, d: Record<string, unknown>) => {
      searches.push({ opts: o, deps: d });
      if (opts.searchThrows) throw new Error("index is gone");
      return { mode: opts.mode ?? "text", ...(opts.reason ? { reason: opts.reason } : {}), results: opts.rows ?? [] };
    },
    ensureSynced: async (p: string) => {
      synced.push(p);
      if (opts.syncThrows) throw new Error("sync broke");
    },
    written: async (scope: string, p: string | null) => {
      written.push([scope, p]);
    },
  });
  const inProject = { sessionId: "s1", projectPath, projectName: "demo" };
  const noProject = { sessionId: "s2", projectPath: null, projectName: null };
  const call = (name: string, args: Record<string, unknown>, binding: unknown = inProject): Promise<Result> =>
    tools.call(binding, name, args);
  return { call, searches, synced, written, embedder, inProject, noProject };
}

const mdFiles = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith(".md")) : []);
const fileOf = (dir: string, id: string) => parseMemoryFile(readFileSync(join(dir, `${id}.md`), "utf8"), id, "project");

const WRITE = { name: "Bash tool shell is zsh", description: "unquoted $LIST is one argument", type: "feedback", body: "Quote every list variable." };

describe("memory tool definitions", () => {
  it("define the four tools with their schemas, limit at most 25", () => {
    expect(defsMod).not.toBeNull();
    const defs = defsMod.MEMORY_TOOL_DEFINITIONS as Array<{ name: string; description: string; inputSchema: any }>;
    expect(defs.map((d) => d.name)).toEqual([...MEMORY_TOOLS]);
    const byName = Object.fromEntries(defs.map((d) => [d.name, d]));
    expect(byName.memory_search.inputSchema.required).toEqual(["query"]);
    expect(byName.memory_search.inputSchema.properties.limit.maximum).toBe(25);
    expect(byName.memory_search.inputSchema.properties.scope.enum).toEqual(["project", "global", "all"]);
    expect(byName.memory_read.inputSchema.required).toEqual(["id"]);
    expect(Object.keys(byName.memory_read.inputSchema.properties).sort()).toEqual(["id", "offset", "scope"]);
    expect([...byName.memory_write.inputSchema.required].sort()).toEqual(["body", "description", "name", "type"]);
    expect(Object.keys(byName.memory_write.inputSchema.properties).sort())
      .toEqual(["body", "description", "id", "name", "revision", "scope", "type"]);
    expect(byName.memory_write.inputSchema.properties.type.enum).toEqual([...MEMORY_TYPES]);
    expect(byName.memory_forget.inputSchema.required).toEqual(["id"]);
    for (const d of defs) {
      expect(d.description.length).toBeGreaterThan(40);
      expect(d.inputSchema.additionalProperties).toBe(false);
    }
  });
});

describe("memory_search", () => {
  it("answers compact rows, never bodies, after syncing the session's project", async () => {
    const t = setup({ mode: "text", reason: "no embedding source is configured" });
    const saved = await memoryStore.write({ scope: "project", projectPath, ...WRITE, type: "feedback", body: "SECRET-BODY-TEXT-xyz" }, { caller: "tool" });
    const row: SearchRow = { id: saved.record.id, scope: "project", name: WRITE.name, description: WRITE.description, source: "ppm", score: 0.873 };
    const t2 = setup({ rows: [row, { id: "codex-summary", scope: "global", name: "Codex notes", description: "what codex learned", source: "codex", score: 0.41 }] });
    const r = await t2.call("memory_search", { query: "zsh quoting", limit: 5 });
    expect(r.isError).toBeUndefined();
    const out = text(r);
    for (const s of [saved.record.id, WRITE.name, WRITE.description, "ppm", "project", "codex-summary", "codex", "global"]) expect(out).toContain(s);
    expect(out).toContain("0.87");
    expect(out).not.toContain("SECRET-BODY-TEXT-xyz");
    expect(t2.searches).toHaveLength(1);
    expect(t2.searches[0]!.opts).toMatchObject({ projectPath, query: "zsh quoting", limit: 5 });
    expect(t2.searches[0]!.deps.embedder).toBe(t2.embedder);
    expect(t2.synced).toEqual([projectPath]);
    // Says why the search ran by text alone.
    const textOnly = await t.call("memory_search", { query: "zsh" });
    expect(text(textOnly)).toContain("no embedding source is configured");
    expect(t.searches[0]!.opts.limit).toBe(10);
  });

  it("searches only the global store for a session with no project, and refuses the project scope there", async () => {
    const t = setup();
    const r = await t.call("memory_search", { query: "zsh" }, t.noProject);
    expect(r.isError).toBeUndefined();
    expect(t.searches[0]!.opts.projectPath).toBeUndefined();
    expect(t.searches[0]!.opts.scope).toBe("global");
    expect(t.synced).toEqual([]);
    const refused = await t.call("memory_search", { query: "zsh", scope: "project" }, t.noProject);
    expect(refused.isError).toBe(true);
    expect(t.searches).toHaveLength(1);
  });

  it("refuses a bad query or limit, and reports a search that failed as an error", async () => {
    const t = setup();
    for (const args of [{ query: "" }, { query: "   " }, {}, { query: "x", limit: 26 }, { query: "x", limit: 0 }, { query: "x", limit: 2.5 }, { query: "x", scope: "everything" }]) {
      expect((await t.call("memory_search", args)).isError).toBe(true);
    }
    expect(t.searches).toHaveLength(0);
    const broken = await setup({ searchThrows: true }).call("memory_search", { query: "zsh" });
    expect(broken.isError).toBe(true);
    expect(text(broken)).toContain("index is gone");
  });

  it("still searches when the sync fails", async () => {
    const t = setup({ syncThrows: true });
    const r = await t.call("memory_search", { query: "zsh" });
    expect(r.isError).toBeUndefined();
    expect(t.searches).toHaveLength(1);
  });
});

describe("memory_write", () => {
  it("creates a PPM memory in the project store by default, answering id, revision and redactions", async () => {
    const t = setup();
    const r = await t.call("memory_write", WRITE);
    expect(r.isError).toBeUndefined();
    const dir = projectMemoryDir(projectPath);
    const files = mdFiles(dir);
    expect(files).toHaveLength(1);
    const id = files[0]!.slice(0, -3);
    expect(id).toMatch(/^m-[0-9a-f]{8}$/);
    const rec = fileOf(dir, id);
    expect(rec.source).toBe("ppm");
    expect(rec.body).toBe(WRITE.body);
    const out = text(r);
    expect(out).toContain(id);
    expect(out).toContain(rec.revision);
    expect(out).toContain("0 secrets redacted");
    expect(t.written).toEqual([["project", projectPath]]);
  });

  it("writes to the global store when asked, or when the session has no project", async () => {
    const t = setup();
    expect((await t.call("memory_write", { ...WRITE, scope: "global" })).isError).toBeUndefined();
    expect(mdFiles(globalMemoryDir())).toHaveLength(1);
    expect(mdFiles(projectMemoryDir(projectPath))).toHaveLength(0);
    expect(t.written[0]![0]).toBe("global");
    expect((await t.call("memory_write", WRITE, t.noProject)).isError).toBeUndefined();
    expect(mdFiles(globalMemoryDir())).toHaveLength(2);
    expect(t.written[1]).toEqual(["global", null]);
    const refused = await t.call("memory_write", { ...WRITE, scope: "project" }, t.noProject);
    expect(refused.isError).toBe(true);
    expect(t.written).toHaveLength(2);
  });

  it("updates at the matching revision, and refuses a stale one with the current revision", async () => {
    const t = setup();
    const { record } = await memoryStore.write({ scope: "project", projectPath, ...WRITE, type: "feedback" }, { caller: "tool" });
    const ok = await t.call("memory_write", { ...WRITE, id: record.id, revision: record.revision, body: "Quote it, always." });
    expect(ok.isError).toBeUndefined();
    const dir = projectMemoryDir(projectPath);
    const updated = fileOf(dir, record.id);
    expect(updated.body).toBe("Quote it, always.");
    expect(text(ok)).toContain(updated.revision);
    expect(t.written).toEqual([["project", projectPath]]);

    const stale = await t.call("memory_write", { ...WRITE, id: record.id, revision: record.revision, body: "lost" });
    expect(stale.isError).toBe(true);
    expect(text(stale)).toContain(updated.revision);
    const missing = await t.call("memory_write", { ...WRITE, id: record.id, body: "no revision" });
    expect(missing.isError).toBe(true);
    expect(text(missing)).toContain(updated.revision);
    expect(fileOf(dir, record.id).body).toBe("Quote it, always.");
    expect(t.written).toHaveLength(1);
  });

  it("refuses to change or forget an imported memory and says to save a new PPM memory", async () => {
    const t = setup();
    const { record } = await memoryStore.write(
      { id: "claude-notes", scope: "project", projectPath, ...WRITE, type: "feedback", source: "claude" },
      { caller: "sync" },
    );
    const w = await t.call("memory_write", { ...WRITE, id: record.id, revision: record.revision, body: "changed" });
    expect(w.isError).toBe(true);
    expect(text(w)).toContain("save a new PPM memory instead");
    const f = await t.call("memory_forget", { id: record.id });
    expect(f.isError).toBe(true);
    expect(text(f)).toContain("save a new PPM memory instead");
    expect(fileOf(projectMemoryDir(projectPath), record.id).archived).toBeUndefined();
    expect(t.written).toEqual([]);
  });

  it("reports how many secrets were redacted, and keeps them out of the file", async () => {
    const t = setup();
    const body = "Deploy with password=hunter2hunter2 and key sk-ant-api03-abcdefghijklmnopqrstuv.";
    const expected = redactSecrets(body).count;
    expect(expected).toBe(2);
    const r = await t.call("memory_write", { ...WRITE, body });
    expect(r.isError).toBeUndefined();
    expect(text(r)).toContain("2 secrets redacted");
    const dir = projectMemoryDir(projectPath);
    const raw = readFileSync(join(dir, mdFiles(dir)[0]!), "utf8");
    expect(raw).not.toContain("hunter2hunter2");
    expect(raw).not.toContain("sk-ant-api03");
  });

  it("refuses invalid input as an error and writes nothing", async () => {
    const t = setup();
    const bad = [
      { ...WRITE, type: "diary" },
      { ...WRITE, name: "" },
      { ...WRITE, body: "" },
      { description: "d", type: "user", body: "b" },
      { ...WRITE, scope: "everywhere" },
      { ...WRITE, id: "../escape", revision: "abc" },
      { ...WRITE, id: "m-00000000", revision: "abc" },
    ];
    for (const args of bad) expect((await t.call("memory_write", args)).isError).toBe(true);
    expect(mdFiles(projectMemoryDir(projectPath))).toHaveLength(0);
    expect(t.written).toEqual([]);
  });
});

describe("memory_read", () => {
  it("answers frontmatter, body and revision, cut at 8,000 characters with the next offset", async () => {
    const t = setup();
    const body = "A".repeat(8000) + "B".repeat(8000) + "C".repeat(4000);
    const { record } = await memoryStore.write({ scope: "project", projectPath, name: "Long note", description: "a long one", type: "reference", body }, { caller: "tool" });
    const first = await t.call("memory_read", { id: record.id });
    expect(first.isError).toBeUndefined();
    const out = text(first);
    for (const s of ["name: Long note", "description: a long one", "type: reference", "source: ppm", `revision: ${record.revision}`, "scope: project"]) {
      expect(out).toContain(s);
    }
    expect(out).toContain("A".repeat(8000));
    expect(out).not.toContain("BBBB");
    expect(out).toContain("offset 8000");
    expect(t.synced).toEqual([projectPath]);

    const second = text(await t.call("memory_read", { id: record.id, offset: 8000 }));
    expect(second).toContain("B".repeat(8000));
    expect(second).not.toContain("AAAA");
    expect(second).not.toContain("CCCC");
    expect(second).toContain("offset 16000");

    const last = text(await t.call("memory_read", { id: record.id, offset: 16000 }));
    expect(last).toContain("C".repeat(4000));
    expect(last).not.toContain("BBBB");
    expect(last).not.toMatch(/offset \d/);
  });

  it("finds a global memory when no scope is given, and reads without a project", async () => {
    const t = setup();
    const { record } = await memoryStore.write({ scope: "global", name: "Everywhere", description: "global one", type: "user", body: "Global body." }, { caller: "tool" });
    const r = await t.call("memory_read", { id: record.id });
    expect(r.isError).toBeUndefined();
    expect(text(r)).toContain("Global body.");
    expect(text(r)).toContain("scope: global");
    const outside = await t.call("memory_read", { id: record.id }, t.noProject);
    expect(text(outside)).toContain("Global body.");
  });

  it("reads even when the sync fails", async () => {
    const t = setup({ syncThrows: true });
    const { record } = await memoryStore.write({ scope: "project", projectPath, ...WRITE, type: "feedback" }, { caller: "tool" });
    const r = await t.call("memory_read", { id: record.id });
    expect(r.isError).toBeUndefined();
    expect(text(r)).toContain(WRITE.body);
  });

  it("answers a missing memory, a bad id or a bad offset as an error", async () => {
    const t = setup();
    const { record } = await memoryStore.write({ scope: "project", projectPath, ...WRITE, type: "feedback" }, { caller: "tool" });
    for (const args of [{ id: "m-deadbeef" }, { id: "../../etc/passwd" }, {}, { id: record.id, offset: -1 }, { id: record.id, offset: 1.5 }, { id: record.id, offset: 999_999 }, { id: record.id, scope: "nowhere" }]) {
      expect((await t.call("memory_read", args)).isError).toBe(true);
    }
    expect((await t.call("memory_read", { id: record.id, scope: "global" })).isError).toBe(true);
  });
});

describe("memory_forget", () => {
  it("archives the memory and keeps its file", async () => {
    const t = setup();
    const { record } = await memoryStore.write({ scope: "project", projectPath, ...WRITE, type: "feedback" }, { caller: "tool" });
    const r = await t.call("memory_forget", { id: record.id });
    expect(r.isError).toBeUndefined();
    const dir = projectMemoryDir(projectPath);
    expect(existsSync(join(dir, `${record.id}.md`))).toBe(true);
    const after = fileOf(dir, record.id);
    expect(after.archived).toBe(true);
    expect(after.body).toBe(WRITE.body);
    expect(text(r)).toContain(record.id);
    expect(t.written).toEqual([["project", projectPath]]);
  });

  it("answers a missing memory as an error", async () => {
    const t = setup();
    expect((await t.call("memory_forget", { id: "m-deadbeef" })).isError).toBe(true);
    expect((await t.call("memory_forget", {})).isError).toBe(true);
    expect(t.written).toEqual([]);
  });

  it("answers an unknown tool name as an error", async () => {
    expect((await setup().call("memory_remember", { id: "x" })).isError).toBe(true);
  });
});

describe("memory tools on the ppm-tabs endpoint", () => {
  function endpoint() {
    const tokens = createTabToolsMcpTokenStore();
    const seen: Array<{ binding: unknown; name: string; args: unknown }> = [];
    let enabled: (tool: string) => boolean = () => true;
    const never = async () => { throw new Error("not this tool"); };
    const handler = createTabToolsMcpHandler({
      resolveToken: (t) => tokens.resolve(t),
      sessionProject: async () => ({ projectPath: "/proj", projectName: "demo" }),
      request: never,
      enabled: (tool) => enabled(tool),
      terminal: { read: never, run: never } as any,
      openUrl: never as any,
      sessionHistory: { call: never } as any,
      memory: {
        call: async (binding: unknown, name: string, args: unknown) => {
          seen.push({ binding, name, args });
          return { content: [{ type: "text", text: `${name} answered` }] };
        },
      },
    } as any);
    const app = new Hono();
    app.all("/api/tab-tools-mcp", handler);
    const token = tokens.mint({ sessionId: "s1" });
    const rpc = async (body: unknown) => (await app.request("http://localhost/api/tab-tools-mcp", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(body),
    })).json();
    return { rpc, seen, setEnabled: (fn: (tool: string) => boolean) => { enabled = fn; } };
  }

  it("lists the memory tools and routes each call to them with the session's binding", async () => {
    const { rpc, seen } = endpoint();
    const list = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const names = (list.result.tools as Array<{ name: string }>).map((t) => t.name);
    for (const tool of MEMORY_TOOLS) expect(names).toContain(tool);
    for (const tool of MEMORY_TOOLS) {
      const res = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: { id: "m-1", query: "q" } } });
      expect(res.result?.content?.[0]?.text).toBe(`${tool} answered`);
    }
    expect(seen.map((s) => s.name)).toEqual([...MEMORY_TOOLS]);
    expect(seen[0]!.binding).toEqual({ sessionId: "s1", projectPath: "/proj", projectName: "demo" });
    expect(seen[0]!.args).toEqual({ id: "m-1", query: "q" });
  });

  it("refuses a memory tool turned off in Settings → Tools before the tools see it", async () => {
    const { rpc, seen, setEnabled } = endpoint();
    setEnabled((tool) => tool !== "memory_write");
    const list = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect((list.result.tools as Array<{ name: string }>).map((t) => t.name)).not.toContain("memory_write");
    const res = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "memory_write", arguments: WRITE } });
    expect(res.result?.isError).toBe(true);
    expect(res.result?.content?.[0]?.text).toContain("turned off memory_write");
    expect(seen).toEqual([]);
  });
});
