/**
 * `/api/memory` (task 18): the route app called directly against a throwaway database and the
 * test PPM_HOME, with the sync, installer, queue and index faked so nothing imports, spawns or
 * downloads. The API test runs the real `ApiEmbedder` against a local `Bun.serve` on port 0.
 * Every response body is searched for the stored key, which must never reach a browser (9.3).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Hono } from "hono";
import { openTestDb, setDb } from "../../../src/services/db.service.ts";
import { configService } from "../../../src/services/config.service.ts";
import { DEFAULT_CONFIG } from "../../../src/types/config.ts";
import { memoryRoot, projectMemoryKey } from "../../../src/services/memory/memory-paths.ts";

// Loaded dynamically so a missing module fails the assertions below, not the file's load.
const MODULE = "../../../src/server/routes/memory.ts";
let mod: any = null;

const FAKE_KEY = "sk-fake-memory-key-7c1f9e2b5a";
const OTHER_KEY = "sk-other-memory-key-3d8a6f0c1e";
const projectDir = resolve(mkdtempSync(join(tmpdir(), "ppm-memory-routes-project-")));
const projectKey = projectMemoryKey(projectDir);

let processConfig: unknown;
beforeAll(async () => {
  processConfig = structuredClone((configService as any).config);
  mod = await import(MODULE).catch(() => null);
});
afterAll(() => {
  setDb(openTestDb());
  (configService as any).config = processConfig;
});

function resetConfig(memory?: unknown) {
  setDb(openTestDb());
  configService.load();
  const config = (configService as any).config;
  config.auth.enabled = false;
  config.ai = structuredClone(DEFAULT_CONFIG.ai);
  if (memory !== undefined) config.ai.memory = memory;
  config.projects = [{ name: "demo", path: projectDir }];
}

const providerStatus = (count: number, error: string | null = null) => ({
  count, syncedAt: "2026-11-12T03:10:00.000Z", error, skipped: [], redacted: 0,
});

interface Fakes {
  events: any[];
  syncAllCalls: number;
  statusCalls: string[];
  queueStatusCalls: Array<string | undefined>;
  kicks: Array<string | undefined>;
  listCalls: Array<{ keys: string[]; opts: unknown }>;
  installCalls: number;
  uninstallCalls: number;
  cancelCalls: number;
  installStatus: any;
}

function makeApp() {
  const f: Fakes = {
    events: [], syncAllCalls: 0, statusCalls: [], queueStatusCalls: [], kicks: [], listCalls: [],
    installCalls: 0, uninstallCalls: 0, cancelCalls: 0, installStatus: { state: "not-installed" },
  };
  const providers = { claude: providerStatus(2), codex: providerStatus(1, "codex db locked"), antigravity: providerStatus(0) };
  const sync = {
    async syncAll() {
      f.syncAllCalls++;
      return [{ projectPath: projectDir, ran: { project: true, global: true }, written: 3, archived: 0 }];
    },
    async status(path: string) {
      f.statusCalls.push(path);
      return structuredClone(providers);
    },
    async statusFile() {
      return { fingerprint: {}, providers: structuredClone(providers), projects: {}, global: { providers: {} } };
    },
  };
  const installer = {
    dir: "/fake/memory-embed",
    status: () => f.installStatus,
    async install() {
      f.installCalls++;
      f.installStatus = { state: "installing", step: "packages", bytes: 0, totalBytes: 650 * 1024 * 1024 };
      return f.installStatus;
    },
    async cancel() { f.cancelCalls++; f.installStatus = { state: "not-installed" }; },
    async uninstall() { f.uninstallCalls++; f.installStatus = { state: "not-installed" }; },
    subscribe: () => () => {},
  };
  const queue = {
    status(key?: string) {
      f.queueStatusCalls.push(key);
      return { model: "local:Xenova/multilingual-e5-small@q8", vectors: 3, total: 5, running: false, reason: null };
    },
    async kick(key?: string) { f.kicks.push(key); },
  };
  const row = (id: string, key: string, archived = false) => ({
    id, scope: key === "global" ? "global" : "project", projectKey: key, path: `/x/${id}.md`, name: id,
    description: "", type: "project", source: "claude", updated: "2026-11-12T00:00:00Z", archived, revision: "r1",
  });
  const index = {
    list(keys: string[], opts: unknown) {
      f.listCalls.push({ keys, opts });
      const all = [
        row("p1", projectKey), row("p2", projectKey), row("p3", projectKey, true),
        row("g1", "global"), row("g2", "global", true),
      ];
      return all.filter((r) => keys.includes(r.projectKey));
    },
  };
  const routes: Hono = mod.createMemoryRoutes({
    broadcast: (event: unknown) => { f.events.push(event); },
    sync, installer, queue, index: () => index,
  });
  const app = new Hono().route("/memory", routes);
  return { app, f };
}

const json = (body: unknown) => ({
  method: "PUT", headers: { "Content-Type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body),
});
const post = (body?: unknown) => ({
  method: "POST", headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
});

/** Reads a response as text, asserts the stored keys are nowhere in it, and parses it. */
async function read(res: Response): Promise<any> {
  const text = await res.text();
  expect(text).not.toContain(FAKE_KEY);
  expect(text).not.toContain(OTHER_KEY);
  return JSON.parse(text);
}

describe("module", () => {
  test("exports the route factory, the mounted routes and the event wiring", () => {
    expect(mod).not.toBeNull();
    expect(typeof mod?.createMemoryRoutes).toBe("function");
    expect(typeof mod?.wireMemoryEvents).toBe("function");
    expect(mod?.memoryRoutes).toBeDefined();
  });
});

describe("GET /status", () => {
  beforeEach(() => resetConfig({ enabled: true, embedding: { source: "local" } }));

  test("answers enabled, root, counts, per-provider status and the embedding state for a project", async () => {
    expect(mod).not.toBeNull();
    const { app, f } = makeApp();
    f.installStatus = { state: "ready" };
    const res = await app.request("/memory/status?project=demo");
    expect(res.status).toBe(200);
    const body = await read(res);
    expect(body.ok).toBe(true);
    const s = body.data;
    expect(s.enabled).toBe(true);
    expect(s.root).toBe(memoryRoot());
    expect(s.counts).toEqual({ project: 2, global: 1, archived: 2 });
    expect(f.listCalls[0]?.keys.sort()).toEqual([projectKey, "global"].sort());
    expect(f.listCalls[0]?.opts).toEqual({ includeArchived: true });
    expect(f.statusCalls).toEqual([projectDir]);
    expect(Object.keys(s.providers).sort()).toEqual(["antigravity", "claude", "codex"]);
    expect(s.providers.claude).toMatchObject({ count: 2, syncedAt: "2026-11-12T03:10:00.000Z", error: null, skipped: [] });
    expect(s.providers.codex.error).toBe("codex db locked");
    expect(f.queueStatusCalls).toContain(projectKey);
    expect(s.embedding).toMatchObject({
      source: "local", model: "local:Xenova/multilingual-e5-small@q8", ready: true, reason: null,
      vectors: 3, total: 5, install: { state: "ready" }, has_api_key: false,
    });
  });

  test("the local source is not ready, with a reason, until the model is installed", async () => {
    expect(mod).not.toBeNull();
    const { app } = makeApp();
    const s = (await read(await app.request("/memory/status?project=demo"))).data;
    expect(s.embedding.ready).toBe(false);
    expect(typeof s.embedding.reason).toBe("string");
    expect(s.embedding.install).toEqual({ state: "not-installed" });
  });

  test("without a project: global counts only, every folder's vectors", async () => {
    expect(mod).not.toBeNull();
    const { app, f } = makeApp();
    const s = (await read(await app.request("/memory/status"))).data;
    expect(s.counts).toEqual({ project: 0, global: 1, archived: 1 });
    expect(f.queueStatusCalls).toContain(undefined);
    expect(Object.keys(s.providers).sort()).toEqual(["antigravity", "claude", "codex"]);
  });

  test("an unknown project is a 404", async () => {
    expect(mod).not.toBeNull();
    const { app } = makeApp();
    const res = await app.request("/memory/status?project=nope");
    expect(res.status).toBe(404);
  });

  test("an API source reports has_api_key and never the key", async () => {
    resetConfig({ enabled: true, embedding: { source: "api", api_url: "http://127.0.0.1:9/v1", api_model: "m", api_key: FAKE_KEY } });
    expect(mod).not.toBeNull();
    const { app } = makeApp();
    const s = (await read(await app.request("/memory/status?project=demo"))).data;
    expect(s.embedding).toMatchObject({ source: "api", api_url: "http://127.0.0.1:9/v1", api_model: "m", has_api_key: true, ready: true });
    expect(s.embedding.api_key).toBeUndefined();
  });

  test("memory off is reported as off", async () => {
    resetConfig({ enabled: false });
    expect(mod).not.toBeNull();
    const { app } = makeApp();
    const s = (await read(await app.request("/memory/status"))).data;
    expect(s.enabled).toBe(false);
    expect(s.embedding.source).toBe("off");
    expect(s.embedding.ready).toBe(false);
  });
});

describe("POST /sync", () => {
  test("syncs every project and answers the results", async () => {
    resetConfig({ enabled: true });
    expect(mod).not.toBeNull();
    const { app, f } = makeApp();
    const res = await app.request("/memory/sync", post());
    expect(res.status).toBe(200);
    const body = await read(res);
    expect(f.syncAllCalls).toBe(1);
    expect(body.data.results).toEqual([{ projectPath: projectDir, ran: { project: true, global: true }, written: 3, archived: 0 }]);
  });

  test("is refused while memory is off (11.3), without syncing", async () => {
    resetConfig({ enabled: false });
    expect(mod).not.toBeNull();
    const { app, f } = makeApp();
    const res = await app.request("/memory/sync", post());
    expect(res.status).toBe(409);
    expect(f.syncAllCalls).toBe(0);
  });
});

describe("PUT /settings", () => {
  beforeEach(() => resetConfig());

  test("saves enabled and an API source; the answer has has_api_key, never the key", async () => {
    expect(mod).not.toBeNull();
    const { app, f } = makeApp();
    const res = await app.request("/memory/settings", json({
      enabled: true, embedding: { source: "api", api_url: "https://emb.example/v1", api_model: "text-embedding-3-small", api_key: FAKE_KEY },
    }));
    expect(res.status).toBe(200);
    const body = await read(res);
    expect(body.data).toEqual({
      enabled: true,
      embedding: { source: "api", api_url: "https://emb.example/v1", api_model: "text-embedding-3-small", has_api_key: true },
    });
    expect(configService.get("ai").memory).toEqual({
      enabled: true,
      embedding: { source: "api", api_url: "https://emb.example/v1", api_model: "text-embedding-3-small", api_key: FAKE_KEY },
    });
    expect(f.events.some((e) => e?.type === "memory:changed")).toBe(true);
    expect(JSON.stringify(f.events)).not.toContain(FAKE_KEY);
  });

  test("an empty or missing key keeps the stored one; a new key replaces it", async () => {
    expect(mod).not.toBeNull();
    const { app } = makeApp();
    const base = { source: "api", api_url: "https://emb.example/v1", api_model: "m1" };
    expect((await app.request("/memory/settings", json({ embedding: { ...base, api_key: FAKE_KEY } }))).status).toBe(200);

    expect((await app.request("/memory/settings", json({ embedding: { ...base, api_model: "m2", api_key: "" } }))).status).toBe(200);
    expect(configService.get("ai").memory?.embedding).toEqual({ ...base, api_model: "m2", api_key: FAKE_KEY });

    expect((await app.request("/memory/settings", json({ embedding: { ...base, api_model: "m3" } }))).status).toBe(200);
    expect(configService.get("ai").memory?.embedding?.api_key).toBe(FAKE_KEY);

    const res = await app.request("/memory/settings", json({ enabled: false }));
    expect(res.status).toBe(200);
    await read(res);
    expect(configService.get("ai").memory).toEqual({ enabled: false, embedding: { ...base, api_model: "m3", api_key: FAKE_KEY } });

    expect((await app.request("/memory/settings", json({ embedding: { ...base, api_key: OTHER_KEY } }))).status).toBe(200);
    expect(configService.get("ai").memory?.embedding?.api_key).toBe(OTHER_KEY);
  });

  test("switching to another source keeps the other settings and kicks the queue", async () => {
    expect(mod).not.toBeNull();
    const { app, f } = makeApp();
    await app.request("/memory/settings", json({ enabled: true, embedding: { source: "api", api_url: "https://emb.example/v1", api_model: "m", api_key: FAKE_KEY } }));
    const res = await app.request("/memory/settings", json({ embedding: { source: "local" } }));
    expect(res.status).toBe(200);
    expect((await read(res)).data.embedding).toMatchObject({ source: "local", has_api_key: true });
    expect(configService.get("ai").memory?.embedding).toEqual({ source: "local", api_url: "https://emb.example/v1", api_model: "m", api_key: FAKE_KEY });
    expect(f.kicks.length).toBeGreaterThan(0);
  });

  test("invalid bodies are a 400 and change nothing", async () => {
    expect(mod).not.toBeNull();
    const { app } = makeApp();
    const before = structuredClone(configService.get("ai"));
    const bad: unknown[] = [
      "not json",
      [],
      null,
      { enabled: "yes" },
      { embedding: "api" },
      { embedding: { source: "cloud" } },
      { embedding: { source: "api" } },
      { embedding: { source: "api", api_url: "ftp://emb.example", api_model: "m" } },
      { embedding: { source: "api", api_url: "not a url", api_model: "m" } },
      { embedding: { source: "api", api_url: "https://emb.example/v1", api_model: 5 } },
      { embedding: { source: "api", api_url: "https://emb.example/v1", api_model: "m", api_key: 5 } },
    ];
    for (const body of bad) {
      const res = await app.request("/memory/settings", json(body === "not json" ? "{nope" : body));
      expect({ body, status: res.status }).toEqual({ body, status: 400 });
    }
    expect(configService.get("ai")).toEqual(before);
  });
});

describe("/embedding/install", () => {
  beforeEach(() => resetConfig({ enabled: true, embedding: { source: "local" } }));

  test("POST starts the install and answers its state", async () => {
    expect(mod).not.toBeNull();
    const { app, f } = makeApp();
    const res = await app.request("/memory/embedding/install", post());
    expect(res.status).toBe(200);
    expect(f.installCalls).toBe(1);
    expect((await read(res)).data).toMatchObject({ state: "installing" });
  });

  test("DELETE removes the model (or stops an install) and answers not-installed", async () => {
    expect(mod).not.toBeNull();
    const { app, f } = makeApp();
    f.installStatus = { state: "ready" };
    const res = await app.request("/memory/embedding/install", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(f.uninstallCalls + f.cancelCalls).toBeGreaterThan(0);
    expect((await read(res)).data).toEqual({ state: "not-installed" });
  });
});

describe("POST /embedding/test", () => {
  let server: ReturnType<typeof Bun.serve>;
  let url = "";
  let lastAuth: string | null = null;
  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        lastAuth = req.headers.get("authorization");
        const body = await req.json() as { model: string; input: string[] };
        if (body.model === "broken") return Response.json({ error: { message: "model broken does not exist" } }, { status: 404 });
        if (lastAuth !== `Bearer ${FAKE_KEY}` && lastAuth !== `Bearer ${OTHER_KEY}`) {
          return Response.json({ error: { message: `Incorrect API key provided: ${lastAuth}` } }, { status: 401 });
        }
        return Response.json({ data: body.input.map((_, index) => ({ index, embedding: [0.1, 0.2, 0.3, 0.4] })) });
      },
    });
    url = `http://127.0.0.1:${server.port}/v1`;
  });
  afterAll(() => server.stop(true));
  beforeEach(() => {
    lastAuth = null;
    resetConfig({ enabled: true, embedding: { source: "api", api_url: url, api_model: "m", api_key: FAKE_KEY } });
  });

  test("the stored settings embed one sentence: ok, dims, ms", async () => {
    expect(mod).not.toBeNull();
    const { app } = makeApp();
    const res = await app.request("/memory/embedding/test", post({}));
    expect(res.status).toBe(200);
    const body = await read(res);
    expect(body.data.ok).toBe(true);
    expect(body.data.dims).toBe(4);
    expect(typeof body.data.ms).toBe("number");
    expect(lastAuth).toBe(`Bearer ${FAKE_KEY}`);
  });

  test("unsaved fields from the body are tested, an empty key meaning the stored one", async () => {
    expect(mod).not.toBeNull();
    const { app } = makeApp();
    const body = await read(await app.request("/memory/embedding/test", post({ source: "api", api_url: url, api_model: "other", api_key: "" })));
    expect(body.data).toMatchObject({ ok: true, dims: 4 });
    expect(lastAuth).toBe(`Bearer ${FAKE_KEY}`);

    const body2 = await read(await app.request("/memory/embedding/test", post({ source: "api", api_url: url, api_model: "other", api_key: OTHER_KEY })));
    expect(body2.data.ok).toBe(true);
    expect(lastAuth).toBe(`Bearer ${OTHER_KEY}`);
    // Testing never saves.
    expect(configService.get("ai").memory?.embedding).toEqual({ source: "api", api_url: url, api_model: "m", api_key: FAKE_KEY });
  });

  test("the endpoint's error comes back as ok:false, with no key in it", async () => {
    expect(mod).not.toBeNull();
    const { app } = makeApp();
    const body = await read(await app.request("/memory/embedding/test", post({ api_model: "broken" })));
    expect(body.data.ok).toBe(false);
    expect(body.data.error).toContain("model broken does not exist");

    // An endpoint that echoes the key back in its error must not carry it to the browser.
    const body2 = await read(await app.request("/memory/embedding/test", post({ api_key: "sk-wrong-but-echoed" })));
    expect(body2.data.ok).toBe(false);
    expect(body2.data.error).toContain("Incorrect API key");
    expect(body2.data.error).not.toContain("sk-wrong-but-echoed");
  });

  test("an unreachable endpoint is ok:false", async () => {
    expect(mod).not.toBeNull();
    const { app } = makeApp();
    const body = await read(await app.request("/memory/embedding/test", post({ api_url: "http://127.0.0.1:1/v1" })));
    expect(body.data.ok).toBe(false);
    expect(typeof body.data.error).toBe("string");
  });

  test("a local model that is not installed is ok:false without starting anything", async () => {
    expect(mod).not.toBeNull();
    const { app } = makeApp();
    const body = await read(await app.request("/memory/embedding/test", post({ source: "local" })));
    expect(body.data.ok).toBe(false);
    expect(body.data.error).toMatch(/not installed/i);
  });

  test("invalid bodies and the Off source are a 400", async () => {
    expect(mod).not.toBeNull();
    const { app } = makeApp();
    for (const body of [{ source: "off" }, { source: "cloud" }, { api_url: "ftp://x" }, { api_key: 5 }, [1]]) {
      const res = await app.request("/memory/embedding/test", post(body));
      expect({ body, status: res.status }).toEqual({ body, status: 400 });
    }
  });
});

describe("wireMemoryEvents", () => {
  test("broadcasts install progress as memory:embed-install and store changes as memory:changed", async () => {
    resetConfig({ enabled: true });
    expect(mod).not.toBeNull();
    const events: any[] = [];
    let installListener: ((s: unknown) => void) | null = null;
    let unsubscribed = false;
    const installer = {
      subscribe(fn: (s: unknown) => void) {
        installListener = fn;
        return () => { unsubscribed = true; };
      },
    };
    // The memory host's events reach the server through the client's one listener.
    let hostListener: ((e: unknown) => void) | null = null;
    let kicks = 0;
    const host = {
      setListener(fn: ((e: unknown) => void) | null) { hostListener = fn; },
      async kick() { kicks++; return null; },
    };
    const unwire = mod.wireMemoryEvents((e: unknown) => events.push(e), installer, host);
    try {
      const status = { state: "installing", step: "model", bytes: 10, totalBytes: 100 };
      installListener!(status);
      expect(events).toContainEqual({ type: "memory:embed-install", status });

      hostListener!({ kind: "changed", change: { projectPath: "", scopes: ["global"] } });
      expect(events.some((e) => e.type === "memory:changed" && Array.isArray(e.scopes) && e.scopes.includes("global"))).toBe(true);

      // The install finishing starts the embedding queue in the host.
      installListener!({ state: "ready" });
      expect(kicks).toBe(1);
    } finally {
      unwire();
    }
    expect(unsubscribed).toBe(true);
    expect(hostListener).toBeNull();
  });
});
