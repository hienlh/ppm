/**
 * `ppm jira` with a server holding the database: configs and watchers go through the routes the
 * Jira panel calls, so every open panel is told (`jira:config_changed`, `jira:watchers_changed`,
 * recorded on the scratch server's `/ws/global`). A new site without a new token clears the saved
 * token, and a test then fails with "no API token" before anything is sent. The token is never an
 * argument and never typed from an AI chat.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import "../test-setup.ts";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runCli, scratchHome, startScratchServer, type ScratchServer } from "../helpers/cli-scratch-server.ts";

let home: string;
let server: ScratchServer;
let projectId: number;
const target = () => `→ PPM default (ppm.db) at 127.0.0.1:${server.port}`;

const jiraEvents = async () => (await server.events()).map((e) => e.type).filter((t): t is string => !!t?.startsWith("jira:"));

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`http://127.0.0.1:${server.port}/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${server.token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = (await res.json()) as { ok: boolean; data: T; error?: string };
  if (!json.ok) throw new Error(`${method} ${path}: ${json.error}`);
  return json.data;
}

async function ok(args: string[], env: Record<string, string> = {}) {
  const r = await runCli(home, args, env);
  expect({ args, code: r.code, err: r.stderr }).toMatchObject({ args, code: 0 });
  return r;
}

beforeAll(async () => {
  home = scratchHome();
  server = await startScratchServer(home, null);
  const dir = join(home, "work");
  mkdirSync(dir, { recursive: true });
  await ok(["projects", "add", dir, "-n", "work"]);
  projectId = (await api<Array<{ id: number; name: string }>>("GET", "/jira/config/projects")).find((p) => p.name === "work")!.id;
}, 60_000);
afterAll(async () => {
  await server?.stop();
  rmSync(home, { recursive: true, force: true });
});

describe("ppm jira config through the server", () => {
  it("clears the token when the site moves, and a test then sends no credential", async () => {
    await api("PUT", `/jira/config/${projectId}`, { baseUrl: "https://first.example", email: "me@example.com", token: "first-site-token" });
    const before = (await jiraEvents()).length;
    const set = await ok(["jira", "config", "set", "work", "--url", "https://other.example", "--email", "me@example.com"]);
    expect(set.stderr).toContain(target());
    expect(set.stdout).toContain("Enter the API token again");
    const configs = await api<Array<{ projectId: number; baseUrl: string; hasToken: boolean }>>("GET", "/jira/config");
    expect(configs.find((c) => c.projectId === projectId)).toMatchObject({ baseUrl: "https://other.example", hasToken: false });
    expect((await jiraEvents()).slice(before)).toEqual(["jira:config_changed"]);

    const test = await runCli(home, ["jira", "config", "test", "work"]);
    expect(test.code).toBe(1);
    expect(test.stderr).toContain("no API token");
    expect((await ok(["jira", "config", "show", "work"])).stdout).toContain("Token: (none");
  }, 60_000);

  it("never takes the token as an argument, nor typed from an AI chat", async () => {
    const before = (await jiraEvents()).length;
    const arg = await runCli(home, ["jira", "config", "set", "work", "--url", "https://x.example", "--email", "e@example.com", "--token", "secret-in-history"]);
    expect(arg.code).toBe(1);
    expect(arg.stderr).toContain("never passed as an argument");
    const ai = await runCli(home, ["jira", "config", "set", "work", "--url", "https://x.example", "--email", "e@example.com", "--token-prompt"], { PPM_AI_CHAT: "1" });
    expect(ai.code).toBe(1);
    expect(ai.stderr).toContain("refused here from an AI chat");
    const noTty = await runCli(home, ["jira", "config", "set", "work", "--url", "https://x.example", "--email", "e@example.com", "--token-prompt"]);
    expect(noTty.code).toBe(1);
    expect(noTty.stderr).toContain("never passed as an argument");
    expect((await jiraEvents()).length).toBe(before);
  }, 60_000);
});

describe("ppm jira watch through the server", () => {
  it("adds, switches and removes a watcher, and every open panel is told", async () => {
    const configId = (await api<Array<{ id: number; projectId: number }>>("GET", "/jira/config")).find((c) => c.projectId === projectId)!.id;
    const before = (await jiraEvents()).length;
    const add = await ok(["jira", "watch", "add", "--config", String(configId), "--name", "bugs", "--jql", "project = BUG", "--mode", "notify"]);
    const id = Number(/id: (\d+)/.exec(add.stdout)![1]);
    const listed = JSON.parse((await ok(["jira", "watch", "list", "--json"])).stdout) as Array<{ id: number; name: string; enabled: boolean }>;
    expect(listed.find((w) => w.id === id)).toMatchObject({ name: "bugs", enabled: true });
    await ok(["jira", "watch", "disable", String(id)]);
    expect((await api<{ enabled: boolean }>("GET", `/jira/watchers/${id}`)).enabled).toBe(false);
    // A watcher of a config whose token was cleared says so instead of asking Jira.
    const dry = await runCli(home, ["jira", "watch", "test", String(id)]);
    expect(dry.code).toBe(1);
    expect(dry.stderr).toContain("no API token");
    await ok(["jira", "watch", "remove", String(id)]);
    expect((await jiraEvents()).slice(before)).toEqual(["jira:watchers_changed", "jira:watchers_changed", "jira:watchers_changed"]);
  }, 60_000);

  it("pulls only inside a running PPM", async () => {
    const lone = scratchHome();
    try {
      const r = await runCli(lone, ["jira", "watch", "pull"]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("runs inside the running PPM");
    } finally {
      rmSync(lone, { recursive: true, force: true });
    }
  }, 60_000);
});
