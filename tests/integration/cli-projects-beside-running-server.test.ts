/**
 * `ppm projects add` run while a server holds the same database — what the PPM Assistant does
 * after the user approves it. The real CLI runs as its own process; this test process plays the
 * server, with the config service open on the CLI's database file.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { applyDbPragmas, getProjects, openTestDb, runMigrations, setDb } from "../../src/services/db.service.ts";
import { configService } from "../../src/services/config.service.ts";

const repoRoot = resolve(import.meta.dir, "..", "..");
let home: string;

async function ppm(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, join(repoRoot, "src", "index.ts"), ...args], {
    cwd: repoRoot,
    env: { ...process.env, PPM_HOME: home, NO_COLOR: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  return { code, stdout, stderr };
}

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "ppm-cli-projects-"));
  for (const name of ["alpha", "gamma"]) mkdirSync(join(home, name));
  const server = new Database(join(home, "ppm.db"));
  applyDbPragmas(server);
  runMigrations(server);
  setDb(server);
  configService.load();
  configService.set("projects", [{ path: join(home, "alpha"), name: "alpha" }]);
});

afterAll(() => {
  setDb(openTestDb());
  configService.load();
  (configService as unknown as { config: { auth: unknown } }).config.auth = { enabled: false, token: "" };
  try { rmSync(home, { recursive: true, force: true }); } catch { /* Windows may hold the WAL briefly */ }
});

describe("ppm projects beside a running server", () => {
  it("a project the CLI adds is listed by the server and survives its next save", async () => {
    const add = await ppm("projects", "add", join(home, "gamma"), "--name", "gamma");
    expect(add.code).toBe(0);

    expect(configService.get("projects").map((p) => p.name)).toEqual(["alpha", "gamma"]);
    configService.set("theme", { style: "slate", mode: "dark" });
    configService.save();
    expect(getProjects().map((p) => p.name)).toEqual(["alpha", "gamma"]);
  }, 30_000);

  it("ppm projects list shows what the database holds", async () => {
    const list = await ppm("projects", "list", "--json");
    expect(list.code).toBe(0);
    // Every command prints the `PPM vX` banner to stdout before its own output.
    const json = list.stdout.slice(list.stdout.indexOf("["));
    expect(JSON.parse(json).map((p: { name: string }) => p.name)).toEqual(["alpha", "gamma"]);

    const table = await ppm("projects", "list");
    expect(table.stdout).not.toContain("No projects registered");
    expect(table.stdout).toContain("gamma");
  }, 30_000);
});
