/**
 * `ppm theme`, `ppm ai`, `ppm proxy`, `ppm keybindings` and `ppm settings` with a server holding
 * the database: each goes through the server's settings routes, so the change lands in its memory
 * and every open PPM is told (`settings:changed {section}`, recorded on the scratch server's
 * `/ws/global`). No output carries a secret, and the advisory AI-chat refusals stop the command
 * before any request is made.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import "../test-setup.ts";
import { rmSync } from "node:fs";
import { runCli, scratchHome, startScratchServer, type ScratchServer } from "../helpers/cli-scratch-server.ts";

let home: string;
let server: ScratchServer;
const AI_CHAT = { PPM_AI_CHAT: "1" };
const target = () => `→ PPM default (ppm.db) at 127.0.0.1:${server.port}`;

/** Every `settings:changed` section the server announced so far, in order. */
const sections = async () => (await server.events() as Array<{ type?: string; section?: string }>)
  .filter((e) => e.type === "settings:changed").map((e) => e.section);

/** A settings route called with the scratch token, as a browser would. */
async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`http://127.0.0.1:${server.port}/api/settings${path}`, {
    method,
    headers: { Authorization: `Bearer ${server.token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return ((await res.json()) as { data: T }).data;
}

beforeAll(async () => {
  home = scratchHome();
  server = await startScratchServer(home, null);
}, 60_000);
afterAll(async () => {
  await server?.stop();
  rmSync(home, { recursive: true, force: true });
});

describe("ppm theme through the server", () => {
  it("re-themes every open PPM: the server holds the theme and announces it", async () => {
    const before = (await sections()).length;
    const set = await runCli(home, ["theme", "set", "slate", "--mode", "dark"]);
    expect({ code: set.code, err: set.stderr }).toMatchObject({ code: 0 });
    expect(set.stderr).toContain(target());
    expect((await server.config()).theme).toEqual({ style: "slate", mode: "dark" });
    expect((await sections()).slice(before)).toEqual(["theme"]);

    expect((await runCli(home, ["theme", "set", "precision"])).code).toBe(0);
    // The last line: the CLI prints its version banner first.
    expect((await runCli(home, ["theme", "get"])).stdout.trim().split("\n").at(-1)).toBe("precision (dark)");
  }, 60_000);

  it("refuses a theme that does not exist, changing nothing", async () => {
    const before = (await sections()).length;
    const bad = await runCli(home, ["theme", "set", "neon"]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain('No theme "neon"');
    expect((await sections()).length).toBe(before);
  }, 60_000);
});

describe("ppm ai through the server", () => {
  it("changes one setting and announces the AI section", async () => {
    const before = (await sections()).length;
    const set = await runCli(home, ["ai", "set", "providers.claude.max_turns", "40"]);
    expect({ code: set.code, err: set.stderr }).toMatchObject({ code: 0 });
    const ai = (await server.config()).ai as { providers: Record<string, Record<string, unknown>> };
    expect(ai.providers.claude!.max_turns).toBe(40);
    expect((await sections()).slice(before)).toEqual(["ai"]);
  }, 60_000);

  it("refuses a provider's command line from an AI chat before any request", async () => {
    const before = (await sections()).length;
    const set = await runCli(home, ["ai", "set", "providers.claude.cli_command", "sh"], AI_CHAT);
    expect(set.code).toBe(1);
    expect(set.stderr).toContain("refused here from an AI chat");
    expect(set.stderr).not.toContain(target());
    expect((await sections()).length).toBe(before);
  }, 60_000);

  it("refuses an API key for a person too, and never prints one", async () => {
    const set = await runCli(home, ["ai", "set", "providers.claude.api_key", "sk-ant-typed-key"]);
    expect(set.code).toBe(1);
    expect(set.stderr).toContain("is a secret");
    await api("PUT", "/ai", { providers: { claude: { api_key: "sk-ant-stored-secret-9876" } } });
    for (const args of [["ai", "get"], ["ai", "get", "--json"], ["ai", "get", "providers.claude"]]) {
      const get = await runCli(home, args);
      expect({ args, code: get.code }).toEqual({ args, code: 0 });
      expect(get.stdout).not.toContain("sk-ant-stored-secret");
      expect(get.stdout).not.toContain("9876");
      expect(get.stdout).toContain("[REDACTED]");
    }
  }, 60_000);
});

describe("ppm proxy through the server", () => {
  it("prints no whole key unless a person asks to reveal it", async () => {
    const gen = await runCli(home, ["proxy", "key", "generate"]);
    expect({ code: gen.code, err: gen.stderr }).toMatchObject({ code: 0 });
    const key = (await api<{ authKey: string }>("GET", "/proxy?reveal=1")).authKey;
    expect(key).toStartWith("ppm-proxy-");
    expect(gen.stdout).not.toContain(key);

    const get = await runCli(home, ["proxy", "get"]);
    expect(get.code).toBe(0);
    expect(get.stdout).not.toContain(key);
    expect(get.stdout).toContain("ppm-…");
    expect((await runCli(home, ["proxy", "get", "--json"])).stdout).not.toContain(key);

    const refused = await runCli(home, ["proxy", "get", "--reveal"], AI_CHAT);
    expect(refused.code).toBe(1);
    expect(refused.stdout).not.toContain(key);
    expect(refused.stderr).not.toContain(target());

    expect((await runCli(home, ["proxy", "get", "--reveal"])).stdout).toContain(key);
  }, 60_000);

  it("refuses switching the proxy or a new key from an AI chat", async () => {
    for (const args of [["proxy", "set", "enabled", "true"], ["proxy", "key", "generate"]]) {
      const r = await runCli(home, args, AI_CHAT);
      expect({ args, code: r.code }).toEqual({ args, code: 1 });
      expect(r.stderr).toContain("refused here from an AI chat");
    }
    expect((await api<{ enabled: boolean }>("GET", "/proxy")).enabled).toBe(false);
  }, 60_000);
});

describe("ppm keybindings and ppm settings through the server", () => {
  it("binds a key for a person and refuses it from an AI chat", async () => {
    expect((await runCli(home, ["keybindings", "set", "open-chat", "Mod+Shift+L"], AI_CHAT)).code).toBe(1);
    const before = (await sections()).length;
    expect((await runCli(home, ["keybindings", "set", "open-chat", "Mod+Shift+L"])).code).toBe(0);
    expect(await api("GET", "/keybindings")).toEqual({ "open-chat": "Mod+Shift+L" });
    expect((await runCli(home, ["keybindings", "reset"])).code).toBe(0);
    expect(await api("GET", "/keybindings")).toEqual({});
    expect((await sections()).slice(before)).toEqual(["keybindings", "keybindings"]);
  }, 60_000);

  it("changes the audit retention, and clears the log only with --yes and never from an AI chat", async () => {
    const before = (await sections()).length;
    expect((await runCli(home, ["settings", "query-audit", "set", "--retention-days", "7"])).code).toBe(0);
    expect((await api<{ retention_days: number }>("GET", "/query-audit")).retention_days).toBe(7);
    expect((await runCli(home, ["settings", "query-audit", "clear"])).code).toBe(1);
    expect((await runCli(home, ["settings", "query-audit", "clear", "--yes"], AI_CHAT)).code).toBe(1);
    expect((await runCli(home, ["settings", "trace", "set", "--retention-days", "30"], AI_CHAT)).code).toBe(1);
    expect((await sections()).slice(before)).toEqual(["query-audit"]);
  }, 60_000);
});
