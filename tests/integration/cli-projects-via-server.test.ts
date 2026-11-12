/**
 * `ppm projects` with a server holding the database: every write goes through the server's own
 * project routes, so the change is in the server's memory at once and every open PPM is told
 * (`projects:changed`, recorded on the scratch server's `/ws/global`). From an AI chat a folder
 * that would put logins inside a project is refused before any request.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import "../test-setup.ts";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { runCli, scratchHome, startScratchServer, type ScratchServer } from "../helpers/cli-scratch-server.ts";

let home: string;
let server: ScratchServer;
const folder = (name: string) => {
  const p = join(home, "work", name);
  mkdirSync(p, { recursive: true });
  return p;
};
const projects = async () => ((await server.config()).projects as Array<{ name: string; path: string; color?: string; image?: string }>);
const changedCount = async () => (await server.events()).filter((e) => e.type === "projects:changed").length;

beforeAll(async () => {
  home = scratchHome();
  server = await startScratchServer(home, null);
}, 60_000);
afterAll(async () => {
  await server?.stop();
  rmSync(home, { recursive: true, force: true });
});

describe("ppm projects through the server", () => {
  it("add and rename reach the server's memory and announce projects:changed", async () => {
    const add = await runCli(home, ["projects", "add", folder("alpha"), "-n", "a"]);
    expect({ code: add.code, err: add.stderr }).toMatchObject({ code: 0 });
    expect(add.stderr).toContain(`→ PPM default (ppm.db) at 127.0.0.1:${server.port}`);
    expect((await projects()).map((p) => p.name)).toEqual(["a"]);
    const before = await changedCount();
    expect(before).toBe(1);

    const rename = await runCli(home, ["projects", "rename", "a", "b"]);
    expect({ code: rename.code, err: rename.stderr }).toMatchObject({ code: 0 });
    expect((await projects()).map((p) => p.name)).toEqual(["b"]);
    expect(await changedCount()).toBe(before + 1);
  }, 60_000);

  it("moves, colours, orders, sets an icon and a setting, then removes, each through the server", async () => {
    expect((await runCli(home, ["projects", "move", "b", folder("beta")])).code).toBe(0);
    expect((await projects())[0]!.path).toBe(join(home, "work", "beta"));
    expect((await runCli(home, ["projects", "color", "b", "#AA00cc"])).code).toBe(0);
    expect((await projects())[0]!.color).toBe("#aa00cc");
    expect((await runCli(home, ["projects", "color", "b", "red"])).code).toBe(1);

    expect((await runCli(home, ["projects", "add", folder("gamma")])).code).toBe(0);
    expect((await runCli(home, ["projects", "reorder", "gamma", "b"])).code).toBe(0);
    expect((await projects()).map((p) => p.name)).toEqual(["gamma", "b"]);

    const png = join(home, "icon.png");
    writeFileSync(png, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]));
    expect((await runCli(home, ["projects", "icon", "b", png])).code).toBe(0);
    expect((await projects()).find((p) => p.name === "b")!.image).toMatch(/\.webp$/);
    const text = join(home, "notes.txt");
    writeFileSync(text, "not an image");
    expect((await runCli(home, ["projects", "icon", "b", text])).code).toBe(1);
    expect((await runCli(home, ["projects", "icon", "b", "--clear"])).code).toBe(0);
    expect((await projects()).find((p) => p.name === "b")!.image).toBeUndefined();

    expect((await runCli(home, ["projects", "settings", "set", "b", "files.useIgnoreFiles", "false"])).code).toBe(0);
    const settings = await runCli(home, ["projects", "settings", "get", "b", "--json"]);
    expect(JSON.parse(settings.stdout)).toMatchObject({ files: { useIgnoreFiles: false } });

    const before = await changedCount();
    expect((await runCli(home, ["projects", "remove", "gamma"])).code).toBe(0);
    expect((await projects()).map((p) => p.name)).toEqual(["b"]);
    expect(await changedCount()).toBe(before + 1);
  }, 120_000);

  it("refuses, from an AI chat, the home folder and its application data, before any request", async () => {
    const before = await changedCount();
    const config = join(homedir(), ".config");
    for (const path of [homedir(), config]) {
      const r = await runCli(home, ["projects", "add", path], { PPM_AI_CHAT: "1" });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("Not added");
      expect(r.stderr).not.toContain("→ PPM");
    }
    const move = await runCli(home, ["projects", "move", "b", homedir()], { PPM_AI_CHAT: "1" });
    expect(move.code).toBe(1);
    expect(move.stderr).toContain("Not moved");
    expect((await projects()).map((p) => p.name)).toEqual(["b"]);
    expect(await changedCount()).toBe(before);
  }, 60_000);

  it("clones a repository through the server, and refuses from an AI chat a clone that would land on the home folder", async () => {
    const bare = join(home, "origin", "tools.git");
    mkdirSync(bare, { recursive: true });
    const init = Bun.spawnSync(["git", "init", "--bare", "-q", bare]);
    expect(init.exitCode).toBe(0);
    const clone = await runCli(home, ["projects", "clone", bare, join(home, "clones")]);
    expect({ code: clone.code, err: clone.stderr }).toMatchObject({ code: 0 });
    expect((await projects()).find((p) => p.name === "tools")?.path).toBe(join(home, "clones", "tools"));
    expect((await runCli(home, ["projects", "remove", "tools"])).code).toBe(0);

    const onHome = await runCli(home, ["projects", "clone", bare, dirname(homedir()), "-n", basename(homedir())], { PPM_AI_CHAT: "1" });
    expect(onHome.code).toBe(1);
    expect(onHome.stderr).toContain("Not cloned");
    expect(onHome.stderr).not.toContain("→ PPM");
  }, 60_000);

  it("a refused write changes nothing and announces nothing", async () => {
    const before = await changedCount();
    const r = await runCli(home, ["projects", "rename", "nope", "x"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Project not found");
    expect(await changedCount()).toBe(before);
  }, 60_000);
});
