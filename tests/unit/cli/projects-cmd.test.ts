/**
 * `ppm projects`: `list` must show what is registered (it once read the config before loading
 * it), and `add`/`remove` must go through a running server, which keeps projects in memory and
 * would not see a write made straight to the database.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { Command } from "commander";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { registerProjectsCommands } from "../../../src/cli/commands/projects.ts";
import { configService } from "../../../src/services/config.service.ts";
import { openTestDb, setDb } from "../../../src/services/db.service.ts";
import { getPpmDir } from "../../../src/services/ppm-dir.ts";

const statusFile = () => resolve(getPpmDir(), "status.json");
// The commands reload config from the database, whose defaults turn auth on. Every test file
// shares this process, so the preload's in-memory config, and a fresh test database, are put back.
const originalConfig = structuredClone((configService as unknown as { config: unknown }).config);
afterAll(() => {
  setDb(openTestDb()); // setDb closed the preload's; a fresh one is what it held
  (configService as unknown as { config: unknown }).config = originalConfig;
});
let lines: string[] = [];
const restore: Array<() => void> = [];
const dirs: string[] = [];
const servers: Array<{ stop(force?: boolean): void }> = [];

beforeEach(() => {
  setDb(openTestDb());
  configService.load();
  lines = [];
  const { log, error } = console;
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  console.error = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  restore.push(() => { console.log = log; console.error = error; });
});

afterEach(() => {
  for (const r of restore.splice(0)) r();
  for (const s of servers.splice(0)) s.stop(true);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  rmSync(statusFile(), { force: true });
});

function projectDir(): string {
  const dir = mkdtempSync(resolve(tmpdir(), "ppm-proj-"));
  dirs.push(dir);
  return dir;
}

/** A port with nothing listening, written where the supervisor would write it. */
function serverDown(): void {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = s.port;
  s.stop(true);
  writeFileSync(statusFile(), JSON.stringify({ port }));
}

function fakeServer(handler: (req: Request) => Response | Promise<Response>) {
  const seen: Array<{ method: string; path: string; body: string }> = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/api/health") return Response.json({ ok: true, data: {} });
      seen.push({ method: req.method, path: decodeURIComponent(url.pathname), body: await req.text() });
      return handler(req);
    },
  });
  servers.push(server);
  writeFileSync(statusFile(), JSON.stringify({ port: server.port }));
  return seen;
}

async function run(...args: string[]) {
  const program = new Command();
  registerProjectsCommands(program);
  const exit = process.exit;
  (process as unknown as { exit: (code?: number) => void }).exit = (code?: number) => { throw new Error(`__exit__${code}`); };
  try {
    await program.parseAsync(["node", "ppm", "projects", ...args]);
    return 0;
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("__exit__")) return Number(e.message.slice(8));
    throw e;
  } finally {
    process.exit = exit;
  }
}

describe("ppm projects list", () => {
  it("lists projects that are registered in the database", async () => {
    const dir = projectDir();
    configService.set("projects", [{ name: "alpha", path: dir }]);
    configService.save();
    // A fresh in-memory config, as a new CLI process has before loading.
    (configService as unknown as { config: { projects: unknown[] } }).config.projects = [];
    await run("list");
    const out = lines.join("\n");
    expect(out).not.toContain("No projects registered");
    expect(out).toContain("alpha");
  });
});

describe("ppm projects add / remove", () => {
  it("goes through the running server when it answers", async () => {
    const dir = projectDir();
    const seen = fakeServer(() => Response.json({ ok: true, data: { name: "via-server", path: dir } }, { status: 201 }));
    expect(await run("add", dir, "--name", "via-server")).toBe(0);
    expect(seen).toEqual([{ method: "POST", path: "/api/projects", body: JSON.stringify({ path: resolve(dir), name: "via-server" }) }]);
    expect(lines.join("\n")).toContain("Added project:");
    // The CLI did not write the list itself: the server owns it.
    expect(configService.get("projects").some((p) => p.name === "via-server")).toBe(false);
  });

  it("prints the server's refusal and exits 1", async () => {
    fakeServer(() => Response.json({ ok: false, error: 'Project "x" already exists' }, { status: 400 }));
    expect(await run("add", projectDir(), "--name", "x")).toBe(1);
    expect(lines.join("\n")).toContain('Project "x" already exists');
  });

  it("writes the database itself when no server is running", async () => {
    serverDown();
    const dir = projectDir();
    expect(await run("add", dir, "--name", "local")).toBe(0);
    expect(configService.get("projects").some((p) => p.name === "local" && p.path === resolve(dir))).toBe(true);
  });

  it("removes through the server, sending a path already resolved", async () => {
    const dir = projectDir();
    const seen = fakeServer(() => Response.json({ ok: true, data: { removed: dir } }));
    expect(await run("remove", "alpha")).toBe(0);
    expect(await run("remove", dir)).toBe(0);
    expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual(["DELETE /api/projects/alpha", `DELETE /api/projects/${resolve(dir)}`]);
  });

  it("removes from the database itself when no server is running", async () => {
    serverDown();
    const dir = projectDir();
    configService.set("projects", [{ name: "gone", path: dir }]);
    configService.save();
    expect(await run("remove", "gone")).toBe(0);
    expect(configService.get("projects").some((p) => p.name === "gone")).toBe(false);
  });
});
