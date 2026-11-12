/**
 * `ppm projects add` run while a server holds the same database — what the PPM Assistant does
 * after the user approves it. The write goes through that server, so the server holds it at once
 * and its own later saves keep it; `ppm projects list` reads the database. With no server holding
 * the database, the same command writes it directly and says so.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runCli, scratchHome, startScratchServer, type ScratchServer } from "../helpers/cli-scratch-server.ts";

let home: string;
let server: ScratchServer;
const names = async () => ((await server.config()).projects as Array<{ name: string }>).map((p) => p.name);

beforeAll(async () => {
  home = scratchHome();
  for (const name of ["alpha", "gamma"]) mkdirSync(join(home, name));
  server = await startScratchServer(home, null);
  expect((await runCli(home, ["projects", "add", join(home, "alpha")])).code).toBe(0);
}, 60_000);

afterAll(async () => {
  await server?.stop();
  try { rmSync(home, { recursive: true, force: true }); } catch { /* Windows may hold the WAL briefly */ }
});

describe("ppm projects beside a running server", () => {
  it("a project the CLI adds is in the server's memory and survives its next save", async () => {
    const add = await runCli(home, ["projects", "add", join(home, "gamma"), "--name", "gamma"]);
    expect({ code: add.code, err: add.stderr }).toMatchObject({ code: 0 });
    expect(add.stderr).toContain(`127.0.0.1:${server.port}`);
    expect(await names()).toEqual(["alpha", "gamma"]);

    // The server saving the list again (a colour change) keeps both.
    expect((await runCli(home, ["projects", "color", "alpha", "#123456"])).code).toBe(0);
    expect(await names()).toEqual(["alpha", "gamma"]);
  }, 60_000);

  it("ppm projects list shows what the database holds", async () => {
    const list = await runCli(home, ["projects", "list", "--json"]);
    expect(list.code).toBe(0);
    expect(JSON.parse(list.stdout).map((p: { name: string }) => p.name)).toEqual(["alpha", "gamma"]);

    const table = await runCli(home, ["projects", "list"]);
    expect(table.stdout).not.toContain("No projects registered");
    expect(table.stdout).toContain("gamma");
  }, 60_000);
});

describe("ppm projects with no server holding the database", () => {
  it("writes the database directly and says so", async () => {
    const solo = scratchHome();
    try {
      mkdirSync(join(solo, "delta"));
      // A port nothing listens on, so "no server holds the database" is provable.
      const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
      const port = probe.port;
      probe.stop(true);
      expect((await runCli(solo, ["init", "-y", "-p", String(port), "--scan", solo])).code).toBe(0);
      const add = await runCli(solo, ["projects", "add", join(solo, "delta")]);
      expect({ code: add.code, err: add.stderr }).toMatchObject({ code: 0 });
      expect(add.stderr).toContain("written directly");
      const rename = await runCli(solo, ["projects", "rename", "delta", "epsilon"]);
      expect(rename.code).toBe(0);
      const list = await runCli(solo, ["projects", "list", "--json"]);
      expect(JSON.parse(list.stdout).map((p: { name: string }) => p.name)).toEqual(["epsilon"]);
    } finally {
      try { rmSync(solo, { recursive: true, force: true }); } catch { /* as above */ }
    }
  }, 90_000);
});
