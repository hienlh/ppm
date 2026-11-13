/**
 * `ppm ext`, `ppm lsp`, `ppm speech` and `ppm db driver` with a server holding the database: each
 * goes through the real route its Settings pane calls, so the running PPM acts on it and every
 * open browser is told (`extensions:changed`, recorded on the scratch server's `/ws/global`).
 * Nothing is downloaded: every install here is one the route refuses (an unknown id), and the
 * extension is a recorded row. Installing or linking an extension is not refused from an AI chat;
 * the shell's approval card is the control for that.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import "../test-setup.ts";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { runCli, scratchHome, startScratchServer, type ScratchServer } from "../helpers/cli-scratch-server.ts";

let home: string;
let server: ScratchServer;
const target = () => `→ PPM default (ppm.db) at 127.0.0.1:${server.port}`;
const extEvents = async () => (await server.events()).filter((e) => e.type === "extensions:changed").length;

async function ok(args: string[], env: Record<string, string> = {}) {
  const r = await runCli(home, args, env);
  expect({ args, code: r.code, err: r.stderr }).toMatchObject({ args, code: 0 });
  return r;
}

async function refusedByRoute(args: string[], message: string, env: Record<string, string> = {}) {
  const r = await runCli(home, args, env);
  expect({ args, code: r.code }).toEqual({ args, code: 1 });
  expect(r.stderr).toContain(target());
  expect(r.stderr).toContain(message);
  return r;
}

beforeAll(async () => {
  home = scratchHome();
  server = await startScratchServer(home, null);
}, 60_000);
afterAll(async () => {
  await server?.stop();
  rmSync(home, { recursive: true, force: true });
});

describe("ppm ext through the server", () => {
  it("disables an extension in the running PPM and tells every open browser", async () => {
    await server.scratch("seed-extension", { id: "ext-cli-demo" });
    const listed = JSON.parse((await ok(["ext", "list", "--json"])).stdout) as Array<{ id: string; enabled: boolean }>;
    expect(listed.find((e) => e.id === "ext-cli-demo")?.enabled).toBe(true);
    const before = await extEvents();
    const off = await ok(["ext", "disable", "ext-cli-demo"]);
    expect(off.stderr).toContain(target());
    const after = JSON.parse((await ok(["ext", "list", "--json"])).stdout) as Array<{ id: string; enabled: boolean }>;
    expect(after.find((e) => e.id === "ext-cli-demo")?.enabled).toBe(false);
    expect((await extEvents()) - before).toBe(1);
  }, 60_000);

  it("lets an AI chat link a local extension (the shell card is the control), and a failure announces nothing", async () => {
    const before = await extEvents();
    const r = await refusedByRoute(["ext", "dev", join(home, "no-such-extension")], "no-such-extension", { PPM_AI_CHAT: "1" });
    expect(r.stderr).not.toContain("refused here from an AI chat");
    expect(await extEvents()).toBe(before);
  }, 60_000);
});

describe("ppm lsp, speech and db driver through the server", () => {
  it("lists language servers and refuses an unknown id at the route", async () => {
    const answer = JSON.parse((await ok(["lsp", "list", "--json"])).stdout) as { servers: Array<{ id: string }>; installDir: string };
    expect(answer.servers.length).toBeGreaterThan(0);
    expect(answer.installDir.startsWith(home)).toBe(true);
    await refusedByRoute(["lsp", "install", "no-such-server"], "No such language server");
    await refusedByRoute(["lsp", "remove", "no-such-server"], "No such language server");
  }, 60_000);

  it("shows speech status and refuses an unknown model at the route", async () => {
    const status = JSON.parse((await ok(["speech", "status", "--json"])).stdout) as { ready: boolean; models: Array<{ id: string }> };
    expect(status.ready).toBe(false);
    expect(status.models.length).toBeGreaterThan(0);
    await refusedByRoute(["speech", "install", "--model", "no-such-model"], "unknown model");
  }, 60_000);

  it("lists database drivers and refuses an unknown one at the route", async () => {
    const drivers = JSON.parse((await ok(["db", "driver", "list", "--json"])).stdout) as Array<{ id: string; state: string }>;
    expect(drivers.map((d) => d.id)).toContain("mysql");
    await refusedByRoute(["db", "driver", "install", "no-such-driver"], "Unknown database driver");
    expect((await ok(["db", "driver", "remove", "mysql"])).stdout).toContain("not installed");
  }, 60_000);
});

describe("without a running PPM", () => {
  it("reads the same routes in this process", async () => {
    const lone = scratchHome();
    try {
      const r = await runCli(lone, ["db", "driver", "list", "--json"]);
      expect({ code: r.code, err: r.stderr }).toMatchObject({ code: 0 });
      expect(r.stderr).not.toContain("→ PPM");
      expect((JSON.parse(r.stdout) as Array<{ id: string }>).map((d) => d.id)).toContain("mysql");
    } finally {
      rmSync(lone, { recursive: true, force: true });
    }
  }, 60_000);
});
