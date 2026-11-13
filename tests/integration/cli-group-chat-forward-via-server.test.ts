/**
 * `ppm forward`, `ppm group-chat`, `ppm teams`, `ppm cloud link|unlink|alias` and `ppm restore`
 * with a server holding the database. Each goes through the route its screen calls; what starts
 * lasting execution or a public address is refused from an AI chat before any request is made;
 * `forward stop` never stops a forward the server did not start, whoever asks.
 *
 * Nothing real is touched: the tunnel list is the scratch server's stand-in (no process is spawned
 * or killed), PPM Cloud is a local stand-in this test serves, and the teams folder is a scratch
 * `HOME` given to the server.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import "../test-setup.ts";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCli, scratchHome, startScratchServer, type ScratchServer } from "../helpers/cli-scratch-server.ts";

let home: string;
let userHome: string;
let server: ScratchServer;
let cloud: ReturnType<typeof Bun.serve>;
const cloudCalls: Array<{ method: string; path: string; body: unknown }> = [];
const AI = { PPM_AI_CHAT: "1" };
const target = () => `→ PPM default (ppm.db) at 127.0.0.1:${server.port}`;
const tunnelCalls = () => server.scratch<Array<{ method: string; path: string; body?: unknown }>>("tunnel-calls");

async function ok(args: string[], env: Record<string, string> = {}) {
  const r = await runCli(home, args, env);
  expect({ args, code: r.code, err: r.stderr }).toMatchObject({ args, code: 0 });
  return r;
}

async function refused(args: string[], message: string, env: Record<string, string> = {}) {
  const r = await runCli(home, args, env);
  expect({ args, code: r.code }).toEqual({ args, code: 1 });
  expect(r.stderr).toContain(message);
  return r;
}

beforeAll(async () => {
  home = scratchHome();
  userHome = `${home}-user`;
  mkdirSync(join(userHome, ".claude", "teams", "alpha", "inboxes"), { recursive: true });
  writeFileSync(join(userHome, ".claude", "teams", "alpha", "inboxes", "lead.json"), "[]");
  cloud = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(req) {
      const path = new URL(req.url).pathname;
      const body = req.method === "GET" || req.method === "DELETE" ? null : await req.json().catch(() => null);
      cloudCalls.push({ method: req.method, path, body });
      if (req.method === "POST" && path === "/api/devices") return Response.json({ id: "dev-1", secret_key: "sk-1" });
      if (req.method === "PATCH" && path === "/api/devices/dev-1/slug") return Response.json({ slug: (body as { slug: string | null }).slug });
      if (req.method === "DELETE" && path === "/api/devices/dev-1") return Response.json({});
      return Response.json({ error: "not found" }, { status: 404 });
    },
  });
  writeFileSync(join(home, "cloud-auth.json"), JSON.stringify({
    access_token: "at-1", refresh_token: "", email: "person@example.test", cloud_url: `http://127.0.0.1:${cloud.port}`, saved_at: new Date().toISOString(),
  }));
  server = await startScratchServer(home, null, undefined, "cli-groups-forward-scratch-server-main.ts", { HOME: userHome, USERPROFILE: userHome });
}, 60_000);
afterAll(async () => {
  await server?.stop();
  cloud?.stop(true);
  for (const dir of [home, userHome, `${home}-project`]) rmSync(dir, { recursive: true, force: true });
});

describe("ppm forward", () => {
  it("lists every tunnel and marks only this PPM's forwards as stoppable", async () => {
    const r = await ok(["forward", "list", "--json"]);
    expect(r.stderr).toContain(target());
    const { tunnels } = JSON.parse(r.stdout) as { tunnels: Array<{ pid: number; stoppable: boolean }> };
    expect(Object.fromEntries(tunnels.map((t) => [t.pid, t.stoppable]))).toEqual({ 41001: true, 41002: false, 41003: false, 41004: true });
  }, 60_000);

  it("never stops a forward this PPM did not start, and stops its own", async () => {
    await refused(["forward", "stop", "41002"], "PID 41002 is not a forward this PPM started");
    await refused(["forward", "stop", "41003"], "PID 41003 is not a forward this PPM started");
    expect((await tunnelCalls()).filter((c) => c.method === "DELETE")).toEqual([]);

    await ok(["forward", "stop", "41001"]);
    expect((await tunnelCalls()).filter((c) => c.method === "DELETE")).toEqual([{ method: "DELETE", path: "/41001" }]);
    await refused(["forward", "stop", "41001"], "PID 41001 is not a forward this PPM started");
  }, 60_000);

  it("refuses start from an AI chat before any request, and starts one for a person", async () => {
    const r = await refused(["forward", "start", "3100"], "port_forward_start", AI);
    expect(r.stderr).not.toContain(target());
    expect((await tunnelCalls()).filter((c) => c.method === "POST")).toEqual([]);

    const made = await ok(["forward", "start", "3100", "--via", "tailscale"]);
    expect(made.stdout).toContain("https://forward-3100.example.test");
    expect((await tunnelCalls()).filter((c) => c.method === "POST")).toEqual([{ method: "POST", path: "/", body: { port: 3100, via: "tailscale" } }]);
    // An AI chat may stop a forward this PPM started.
    await ok(["forward", "stop", "42000"], AI);
  }, 60_000);
});

describe("ppm group-chat", () => {
  type Shown = { id: string; status: string; maxTurns: number; members: Array<{ id: string; name: string; role: string; persona: string | null }> };
  const show = async (id: string) => JSON.parse((await ok(["group-chat", "show", id, "--json"])).stdout) as Shown;
  const list = async () => JSON.parse((await ok(["group-chat", "list", "-p", "demo", "--json"])).stdout) as Array<{ id: string }>;

  it("refuses create from an AI chat before any request", async () => {
    const r = await refused(["group-chat", "create", "Crew", "--leader", "Lead", "-p", "demo"], "refused here from an AI chat", AI);
    expect(r.stderr).not.toContain(target());
    expect(await list()).toEqual([]);
  }, 60_000);

  it("creates, changes and deletes a group chat through the routes, and refuses what starts turns from an AI chat", async () => {
    const made = await ok(["group-chat", "create", "Crew", "--leader", "Lead", "--member", "Dev", "--max-turns", "5", "-p", "demo", "--json"]);
    expect(made.stderr).toContain(target());
    const { id } = JSON.parse(made.stdout) as { id: string };
    expect((await list()).map((g) => g.id)).toEqual([id]);
    expect((await show(id)).members.map((m) => `${m.name}:${m.role}`).sort()).toEqual(["Dev:member", "Lead:leader"]);

    await refused(["group-chat", "members", "add", id, "QA"], "refused here from an AI chat", AI);
    await refused(["group-chat", "message", id, "hello"], "refused here from an AI chat", AI);
    await refused(["group-chat", "resume", id], "refused here from an AI chat", AI);
    expect((await show(id)).members).toHaveLength(2);

    await ok(["group-chat", "members", "add", id, "QA", "--persona", "Tests things"]);
    const dev = (await show(id)).members.find((m) => m.name === "Dev")!;
    await ok(["group-chat", "members", "edit", id, dev.id, "--leader"], AI);
    const lead = (await show(id)).members.find((m) => m.name === "Lead")!;
    expect(lead.role).toBe("member");
    await ok(["group-chat", "members", "remove", id, lead.id]);
    await refused(["group-chat", "members", "remove", id, dev.id], "reassign the leader");
    await ok(["group-chat", "set", id, "--max-turns", "7"]);
    await refused(["group-chat", "set", id, "--max-turns", "99"], "maxTurns must be 1");
    await ok(["group-chat", "stop", id]);
    const after = await show(id);
    expect({ status: after.status, maxTurns: after.maxTurns, members: after.members.map((m) => m.name).sort() })
      .toEqual({ status: "paused", maxTurns: 7, members: ["Dev", "QA"] });

    await ok(["group-chat", "delete", id]);
    expect(await list()).toEqual([]);
  }, 60_000);
});

describe("ppm teams", () => {
  it("lists the teams and deletes one only when it is a team", async () => {
    const teams = JSON.parse((await ok(["teams", "list", "--json"])).stdout) as Array<{ name: string }>;
    expect(teams.map((t) => t.name)).toEqual(["alpha"]);
    await refused(["teams", "delete", "nope"], "Team not found");
    await ok(["teams", "delete", "alpha"]);
    expect(existsSync(join(userHome, ".claude", "teams", "alpha"))).toBe(false);
  }, 60_000);
});

describe("ppm cloud through the server", () => {
  const device = () => join(home, "cloud-device.json");

  it("refuses link and alias set from an AI chat, and links, sets, removes and unlinks for a person", async () => {
    await refused(["cloud", "link"], "refused here from an AI chat", AI);
    expect(cloudCalls).toEqual([]);

    const linked = await ok(["cloud", "link", "--name", "Box"]);
    expect(linked.stderr).toContain(target());
    expect(cloudCalls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /api/devices"]);
    expect(JSON.parse(readFileSync(device(), "utf8"))).toMatchObject({ device_id: "dev-1", name: "Box" });

    const sneaky = await refused(["cloud", "alias", "set", "macbook"], "refused here from an AI chat", AI);
    expect(sneaky.stderr).not.toContain(target());
    expect(cloudCalls).toHaveLength(1);

    const set = await ok(["cloud", "alias", "set", "macbook"]);
    expect(set.stderr).toContain(target());
    expect(set.stdout).toContain(`http://127.0.0.1:${cloud.port}/macbook`);
    expect(cloudCalls[1]).toEqual({ method: "PATCH", path: "/api/devices/dev-1/slug", body: { slug: "macbook", secret_key: "sk-1" } });

    await ok(["cloud", "alias", "remove"], AI);
    expect(cloudCalls[2]?.body).toEqual({ slug: null, secret_key: "sk-1" });

    await ok(["cloud", "unlink"]);
    expect(cloudCalls[3]).toMatchObject({ method: "DELETE", path: "/api/devices/dev-1" });
    expect(existsSync(device())).toBe(false);
  }, 60_000);
});

describe("ppm restore from an AI chat", () => {
  it("is refused with or without --force, while --list still answers", async () => {
    await refused(["restore"], "replaces PPM's whole database", AI);
    await refused(["restore", "--force"], "replaces PPM's whole database", AI);
    await ok(["restore", "--list"], AI);
  }, 60_000);
});
