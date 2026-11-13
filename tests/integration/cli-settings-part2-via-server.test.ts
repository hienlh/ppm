/**
 * `ppm notify`, `ppm telegram-bot`, `ppm ppmbot`, `ppm mcp` and `ppm accounts` with a server holding
 * the database: each goes through the routes Settings calls, the change lands in the server's
 * memory and every open PPM is told (`settings:changed {section}`, recorded on the scratch server's
 * `/ws/global`). No secret is taken as an argument or printed, and the advisory AI-chat refusals
 * stop a command before any request is made.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import "../test-setup.ts";
import { rmSync } from "node:fs";
import { runCli, scratchHome, startScratchServer, type ScratchServer } from "../helpers/cli-scratch-server.ts";
import { startFakeNtfy, WRITER_TOKEN, type FakeNtfy } from "../helpers/fake-ntfy-server.ts";

let home: string;
let server: ScratchServer;
let ntfyA: FakeNtfy;
let ntfyB: FakeNtfy;
const AI_CHAT = { PPM_AI_CHAT: "1" };
const target = () => `→ PPM default (ppm.db) at 127.0.0.1:${server.port}`;

const sections = async () => (await server.events() as Array<{ type?: string; section?: string }>)
  .filter((e) => e.type === "settings:changed").map((e) => e.section);

/** A route called with the scratch token, as a browser would. `path` is under `/api`. */
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

/** Runs the command from an AI chat and checks it was refused before any request. */
async function expectRefusedFromAiChat(args: string[]): Promise<void> {
  const before = (await sections()).length;
  const r = await runCli(home, args, AI_CHAT);
  expect({ args, code: r.code }).toEqual({ args, code: 1 });
  expect(r.stderr).toContain("refused here from an AI chat");
  expect(r.stderr).not.toContain(target());
  expect((await sections()).length).toBe(before);
}

beforeAll(async () => {
  home = scratchHome();
  server = await startScratchServer(home, null);
  ntfyA = startFakeNtfy();
  ntfyB = startFakeNtfy();
}, 60_000);
afterAll(async () => {
  ntfyA?.stop();
  ntfyB?.stop();
  await server?.stop();
  rmSync(home, { recursive: true, force: true });
});

describe("ppm notify through the server", () => {
  it("switches an event on for anyone, and off only for a person", async () => {
    await expectRefusedFromAiChat(["notify", "set", "done", "off"]);
    const before = (await sections()).length;
    const off = await runCli(home, ["notify", "set", "done", "off"]);
    expect({ code: off.code, err: off.stderr }).toMatchObject({ code: 0 });
    expect(off.stderr).toContain(target());
    expect((await runCli(home, ["notify", "delay", "30"], AI_CHAT)).code).toBe(0);
    const settings = await api<{ events: Record<string, boolean>; delay_seconds: number }>("GET", "/notifications/settings");
    expect(settings.events.done).toBe(false);
    expect(settings.delay_seconds).toBe(30);
    expect((await sections()).slice(before)).toEqual(["notifications", "notifications"]);
  }, 60_000);

  it("drops the old server's token when ntfy moves to another server", async () => {
    await api("PUT", "/notifications/ntfy", { server: ntfyA.url, topic: "ppm-test", token: WRITER_TOKEN });
    await expectRefusedFromAiChat(["notify", "ntfy", "set", "--server", ntfyB.url]);
    const set = await runCli(home, ["notify", "ntfy", "set", "--server", ntfyB.url]);
    expect({ code: set.code, err: set.stderr }).toMatchObject({ code: 0 });
    expect(set.stdout).toContain("token was dropped");
    const ntfy = (await server.config()).ntfy as { server: string; topic: string; token: string };
    expect(ntfy).toEqual({ server: ntfyB.url, topic: "ppm-test", token: "" });
    // The token reached server A when it was saved, and never server B.
    expect(ntfyA.requests.some((r) => r.auth === `Bearer ${WRITER_TOKEN}`)).toBe(true);
    expect(ntfyB.requests.every((r) => r.auth === null)).toBe(true);
    expect(set.stdout + set.stderr).not.toContain(WRITER_TOKEN);
  }, 60_000);

  it("never makes a connect link or removes a channel from an AI chat", async () => {
    await expectRefusedFromAiChat(["notify", "telegram", "connect"]);
    await expectRefusedFromAiChat(["notify", "ntfy", "remove"]);
    await expectRefusedFromAiChat(["telegram-bot", "remove"]);
  }, 60_000);
});

describe("tokens are typed, never passed", () => {
  it("asks for the notification bot's token at a terminal, and refuses without one", async () => {
    const r = await runCli(home, ["telegram-bot", "set", "--token-prompt"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("never passed as an argument");
    expect(r.stderr).not.toContain(target());
    expect((await runCli(home, ["telegram-bot", "set", "--token-prompt"], AI_CHAT)).stderr).toContain("refused here from an AI chat");
    expect((await runCli(home, ["telegram-bot", "set", "123:abc"])).code).not.toBe(0);
  }, 60_000);
});

describe("ppm ppmbot through the server", () => {
  it("changes the bridge's options, and never switches it on or makes a link from an AI chat", async () => {
    await expectRefusedFromAiChat(["ppmbot", "connect"]);
    await expectRefusedFromAiChat(["ppmbot", "set", "enabled", "true"]);
    await expectRefusedFromAiChat(["ppmbot", "token", "--token-prompt"]);
    const before = (await sections()).length;
    const set = await runCli(home, ["ppmbot", "set", "debounce", "500"]);
    expect({ code: set.code, err: set.stderr }).toMatchObject({ code: 0 });
    expect((await api<{ debounce_ms: number }>("GET", "/settings/clawbot")).debounce_ms).toBe(500);
    expect((await sections()).slice(before)).toEqual(["clawbot"]);
  }, 60_000);

  it("needs a running PPM to change the bridge", async () => {
    const lone = scratchHome();
    try {
      const r = await runCli(lone, ["ppmbot", "set", "debounce", "500"]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("runs inside the running PPM");
    } finally {
      rmSync(lone, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("ppm mcp through the server", () => {
  it("adds a server for a person, refuses its command from an AI chat, and never prints a value", async () => {
    await expectRefusedFromAiChat(["mcp", "add", "files", "--command", "npx", "--arg", "server-files"]);
    await expectRefusedFromAiChat(["mcp", "import"]);
    const before = (await sections()).length;
    const add = await runCli(home, ["mcp", "add", "files", "--command", "npx", "--arg", "server-files"]);
    expect({ code: add.code, err: add.stderr }).toMatchObject({ code: 0 });
    expect(await api("GET", "/settings/mcp/files")).toEqual({ command: "npx", args: ["server-files"] });

    await api("PUT", "/settings/mcp/files", { command: "npx", args: ["server-files"], env: { API_TOKEN: "mcp-secret-value-77" } });
    for (const args of [["mcp", "list"], ["mcp", "list", "--json"]]) {
      const list = await runCli(home, args, AI_CHAT);
      expect({ args, code: list.code }).toEqual({ args, code: 0 });
      expect(list.stdout).toContain("API_TOKEN");
      expect(list.stdout).not.toContain("mcp-secret-value-77");
    }
    // An env value is typed at a terminal: with none, the edit stops before any request.
    const env = await runCli(home, ["mcp", "edit", "files", "--env", "OTHER"]);
    expect(env.code).toBe(1);
    expect(env.stderr).toContain("never passed as an argument");

    expect((await runCli(home, ["mcp", "remove", "files"], AI_CHAT)).code).toBe(0);
    expect((await sections()).slice(before)).toEqual(["mcp", "mcp", "mcp"]);
  }, 60_000);
});

describe("ppm accounts through the server", () => {
  it("lists accounts without their tokens and renames one", async () => {
    const token = "sk-ant-oat01-SEEDED-SECRET-4242";
    await server.scratch("seed-account", { id: "acc-0001-aaaa", label: "Work", email: "me@example.com", token });
    for (const args of [["accounts", "list"], ["accounts", "list", "--json"], ["accounts", "list", "--provider", "claude"]]) {
      const list = await runCli(home, args);
      expect({ args, code: list.code }).toEqual({ args, code: 0 });
      expect(list.stdout).toContain("acc-0001-aaaa");
      expect(list.stdout).not.toContain("SEEDED-SECRET");
    }
    const before = (await sections()).length;
    const rename = await runCli(home, ["accounts", "rename", "acc-0001", "Personal"]);
    expect({ code: rename.code, err: rename.stderr }).toMatchObject({ code: 0 });
    const accounts = await api<Array<{ id: string; label: string }>>("GET", "/accounts");
    expect(accounts.find((a) => a.id === "acc-0001-aaaa")?.label).toBe("Personal");
    expect((await runCli(home, ["accounts", "remove", "acc-0001-aaaa"])).code).toBe(1);
    expect((await sections()).slice(before)).toEqual(["accounts"]);
  }, 60_000);
});
