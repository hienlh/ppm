/**
 * With no PPM running on the database, `ppm tags` runs the same tag routes inside the CLI's own
 * process, after the direct-write notice, and `ppm chat stop` has nothing to stop.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runCli, scratchHome } from "../../helpers/cli-scratch-server.ts";

let home: string;

beforeAll(async () => {
  home = scratchHome();
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const freePort = probe.port;
  probe.stop(true);
  expect((await runCli(home, ["init", "-y", "-p", String(freePort)])).code).toBe(0);
  const dir = join(home, "work", "alpha");
  mkdirSync(dir, { recursive: true });
  expect((await runCli(home, ["projects", "add", dir, "-n", "alpha"])).code).toBe(0);
}, 90_000);
afterAll(() => rmSync(home, { recursive: true, force: true }));

describe("ppm tags and ppm chat with no server", () => {
  it("adds, lists and removes a tag directly, with a notice, through the same routes", async () => {
    const add = await runCli(home, ["tags", "add", "Work", "-p", "alpha"]);
    expect({ code: add.code, err: add.stderr }).toMatchObject({ code: 0 });
    expect(add.stderr).toContain("No PPM is running on ppm.db; written directly");
    const list = await runCli(home, ["tags", "list", "-p", "alpha", "--json"]);
    expect((JSON.parse(list.stdout) as { tags: Array<{ name: string }> }).tags.map((t) => t.name)).toContain("Work");
    const bad = await runCli(home, ["tags", "add", "Bad", "-p", "alpha", "--color", "red"]);
    expect(bad.code).toBe(1);
    expect((await runCli(home, ["tags", "remove", "work", "-p", "alpha"])).code).toBe(0);
  }, 90_000);

  it("chat stop says no turn can be running", async () => {
    const r = await runCli(home, ["chat", "stop", "11111111-2222-3333-4444-555555555555", "-p", "alpha"]);
    expect({ code: r.code, err: r.stderr }).toMatchObject({ code: 0 });
    expect(r.stdout).toContain("No PPM is running");
  }, 60_000);
});
