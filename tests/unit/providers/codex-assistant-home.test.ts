/**
 * A PPM Assistant app-server runs on a CODEX_HOME of its own, so the user's AGENTS.md,
 * config.toml and skills stay behind, while the login and the sessions folder are the
 * account's own through links: a token codex refreshes from either side lands in the one
 * file, and the Assistant's rollouts are written where PPM reads Codex history.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import "../../test-setup.ts";
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync,
  symlinkSync, unlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assistantCodexHomesRoot, assistantSpawnHome, prepareAssistantCodexHome, removeAssistantCodexHome, sweepAssistantCodexHomes,
} from "../../../src/providers/codex-app-server/codex-assistant-home.ts";
import { assertNotPpmDir } from "../../../src/services/fs-credential-path-guard.ts";
import { planAssistantCodexSkills } from "../../../src/providers/codex-app-server/codex-assistant-skills.ts";
import { assistantSessionConfig } from "../../../src/providers/codex-app-server/codex-thread-params.ts";
import { CodexAppServerProvider } from "../../../src/providers/codex-app-server/codex-provider.ts";
import { CodexJsonRpcClient } from "../../../src/providers/codex-app-server/codex-jsonrpc-client.ts";
import * as accounts from "../../../src/services/codex-account.service.ts";
import { configService } from "../../../src/services/config.service.ts";

const auth = (lastRefresh: string, token: string) => JSON.stringify({ auth_mode: "chatgpt", tokens: { refresh_token: token }, last_refresh: lastRefresh });
const sameFile = (a: string, b: string) => {
  const x = statSync(a, { bigint: true });
  const y = statSync(b, { bigint: true });
  return x.ino === y.ino && x.dev === y.dev;
};

let base: string;
let root: string;
let account: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "ppm-assistant-home-"));
  root = join(base, "homes");
  account = join(base, "account");
  mkdirSync(join(account, "sessions"), { recursive: true });
  writeFileSync(join(account, "auth.json"), auth("2026-10-01T00:00:00Z", "rt-1"));
  writeFileSync(join(account, "AGENTS.md"), "the user's global instructions");
  writeFileSync(join(account, "config.toml"), "[mcp_servers.mine]\ncommand = \"x\"\n");
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function prepared(): string {
  const result = prepareAssistantCodexHome(account, root);
  if (!result.home) throw new Error(`not prepared: ${result.reason}`);
  return result.home;
}

describe("the Assistant's CODEX_HOME", () => {
  it("holds the account's login and sessions through links, and nothing else of the user's", () => {
    const home = prepared();
    expect(home.startsWith(root)).toBe(true);
    expect(sameFile(join(home, "auth.json"), join(account, "auth.json"))).toBe(true);
    expect(lstatSync(join(home, "sessions")).isSymbolicLink()).toBe(true);
    expect(realpathSync(join(home, "sessions"))).toBe(realpathSync(join(account, "sessions")));
    expect(existsSync(join(home, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(home, "config.toml"))).toBe(false);

    // A rollout written through the link is where PPM's history readers look.
    writeFileSync(join(home, "sessions", "rollout-a.jsonl"), "{}\n");
    expect(existsSync(join(account, "sessions", "rollout-a.jsonl"))).toBe(true);
  });

  it("shares every in-place rewrite of auth.json in both directions, so a refreshed token is never forked", () => {
    const home = prepared();
    writeFileSync(join(home, "auth.json"), auth("2026-10-09T00:00:00Z", "rt-2")); // codex refreshing from the Assistant
    expect(readFileSync(join(account, "auth.json"), "utf8")).toContain("rt-2");
    writeFileSync(join(account, "auth.json"), auth("2026-10-10T00:00:00Z", "rt-3")); // and from an ordinary chat
    expect(readFileSync(join(home, "auth.json"), "utf8")).toContain("rt-3");
  });

  it("is the same home on every spawn, and different for another account", () => {
    const home = prepared();
    expect(prepared()).toBe(home);
    expect(sameFile(join(home, "auth.json"), join(account, "auth.json"))).toBe(true);
    const other = join(base, "other");
    mkdirSync(other);
    writeFileSync(join(other, "auth.json"), auth("2026-10-01T00:00:00Z", "rt-o"));
    expect(prepareAssistantCodexHome(other, root).home).not.toBe(home);
  });

  it("follows an account auth.json that was replaced rather than rewritten (a fresh sign-in)", () => {
    const home = prepared();
    writeFileSync(join(base, "fresh.json"), auth("2026-10-10T00:00:00Z", "rt-new"));
    renameSync(join(base, "fresh.json"), join(account, "auth.json"));
    expect(sameFile(join(home, "auth.json"), join(account, "auth.json"))).toBe(false);
    prepared();
    expect(sameFile(join(home, "auth.json"), join(account, "auth.json"))).toBe(true);
    expect(readFileSync(join(home, "auth.json"), "utf8")).toContain("rt-new");
  });

  it("writes a newer login found only on the Assistant's side back into the account before relinking", () => {
    const home = prepared();
    unlinkSync(join(home, "auth.json"));
    writeFileSync(join(home, "auth.json"), auth("2026-10-09T00:00:00Z", "rt-refreshed"));
    prepared();
    expect(readFileSync(join(account, "auth.json"), "utf8")).toContain("rt-refreshed");
    expect(sameFile(join(home, "auth.json"), join(account, "auth.json"))).toBe(true);
  });

  it("keeps the account's login when the Assistant's diverged copy is older", () => {
    const home = prepared();
    unlinkSync(join(home, "auth.json"));
    writeFileSync(join(home, "auth.json"), auth("2026-09-01T00:00:00Z", "rt-stale"));
    prepared();
    expect(readFileSync(join(account, "auth.json"), "utf8")).toContain("rt-1");
    expect(sameFile(join(home, "auth.json"), join(account, "auth.json"))).toBe(true);
  });

  it("is not used for an account with no auth.json, and drops the link a signed-out account left", () => {
    const home = prepared();
    unlinkSync(join(account, "auth.json"));
    const result = prepareAssistantCodexHome(account, root);
    expect(result.home).toBeNull();
    expect(existsSync(join(home, "auth.json"))).toBe(false);
  });

  it("is not used while its sessions folder is a real folder holding rollouts", () => {
    const home = prepared();
    unlinkSync(join(home, "sessions"));
    mkdirSync(join(home, "sessions"));
    writeFileSync(join(home, "sessions", "rollout-x.jsonl"), "{}\n");
    expect(prepareAssistantCodexHome(account, root).home).toBeNull();
    expect(existsSync(join(home, "sessions", "rollout-x.jsonl"))).toBe(true);
  });

  it("falls back to the account's own home, never throwing, when it cannot be prepared", () => {
    const signedOut = join(base, "signed-out");
    mkdirSync(signedOut);
    expect(assistantSpawnHome(signedOut)).toBe(signedOut);
  });
});

describe("sweeping the Assistant's homes", () => {
  it("deletes a home whose account is gone, without walking through its sessions link", () => {
    const home = prepared();
    const keep = join(base, "elsewhere");
    mkdirSync(keep);
    writeFileSync(join(keep, "rollout-keep.jsonl"), "{}\n");
    // Point the link somewhere that outlives the account, then remove the account.
    unlinkSync(join(home, "sessions"));
    symlinkSync(keep, join(home, "sessions"), process.platform === "win32" ? "junction" : "dir");
    rmSync(account, { recursive: true, force: true });

    sweepAssistantCodexHomes(root);
    expect(existsSync(home)).toBe(false);
    expect(existsSync(join(keep, "rollout-keep.jsonl"))).toBe(true);
  });

  it("keeps the home of an account that still exists", () => {
    const home = prepared();
    sweepAssistantCodexHomes(root);
    expect(existsSync(join(home, "auth.json"))).toBe(true);
  });
});

describe("removing an account's Assistant home", () => {
  it("deletes the home through its links, leaving the account's login and rollouts alone", () => {
    const home = prepared();
    writeFileSync(join(account, "sessions", "rollout-a.jsonl"), "{}\n");
    expect(lstatSync(join(home, "sessions")).isSymbolicLink()).toBe(true);

    expect(removeAssistantCodexHome(account, root)).toBe(true);
    expect(existsSync(home)).toBe(false);
    expect(readFileSync(join(account, "auth.json"), "utf8")).toContain("rt-1");
    expect(existsSync(join(account, "sessions", "rollout-a.jsonl"))).toBe(true);
  });

  it("answers true when the account never had one", () => {
    expect(removeAssistantCodexHome(join(base, "never-used"), root)).toBe(true);
  });
});

describe("the Assistant home's generated images", () => {
  let home: string;
  beforeEach(() => {
    // Under the real (test) PPM dir, the only place the file guard's exception applies.
    const result = prepareAssistantCodexHome(account);
    if (!result.home) throw new Error(`not prepared: ${result.reason}`);
    home = result.home;
    expect(home.startsWith(assistantCodexHomesRoot())).toBe(true);
  });
  afterEach(() => { removeAssistantCodexHome(account); });

  it("are readable through the file guard, as an account home's are, by path and by real path", () => {
    const image = join(home, "generated_images", "thread-1", "call_1.png");
    mkdirSync(join(home, "generated_images", "thread-1"), { recursive: true });
    writeFileSync(image, "png");
    expect(() => assertNotPpmDir(image)).not.toThrow();
    expect(() => assertNotPpmDir(realpathSync(image))).not.toThrow();
  });

  it("leave the home's login, marker and sessions link refused", () => {
    writeFileSync(join(home, "sessions", "rollout-a.jsonl"), "{}\n");
    for (const path of [join(home, "auth.json"), join(home, ".ppm-source"), join(home, "sessions", "rollout-a.jsonl"), home]) {
      expect(() => assertNotPpmDir(path)).toThrow("Access denied");
    }
  });
});

describe("the Assistant's skills", () => {
  it("lists every skill the app-server reports, each to be switched off by name", async () => {
    const client = {
      request: async (method: string) => {
        expect(method).toBe("skills/list");
        return { data: [{ cwd: "/w", skills: [{ name: "ak-advise", enabled: true }, { name: "imagegen", scope: "system" }, { name: "" }] }] };
      },
    };
    expect(await planAssistantCodexSkills(client as never, "/w")).toEqual(["ak-advise", "imagegen"]);
  });

  it("keeps the catalogue out of the prompt and disables each listed skill", () => {
    const config = assistantSessionConfig({ disableSkills: ["ak-advise", "imagegen"] });
    expect(config).toMatchObject({
      "skills.include_instructions": false,
      "skills.bundled.enabled": false,
      "skills.config": [{ name: "ak-advise", enabled: false }, { name: "imagegen", enabled: false }],
    });
    expect(assistantSessionConfig({})["skills.config"]).toBeUndefined();
  });
});

describe("an Assistant session on Codex", () => {
  const spies: Array<{ mockRestore(): void }> = [];
  let previousAi: ReturnType<typeof configService.get<"ai">>;
  let started: Array<{ codexHome?: string }>;
  let threadStarts: Array<Record<string, any>>;

  beforeEach(() => {
    started = [];
    threadStarts = [];
    previousAi = configService.get("ai");
    configService.set("ai", { ...previousAi, providers: { ...previousAi.providers, codex: { type: "cli", cli_command: "codex" } } });
    const acct = { id: "acct-1", label: "acct", home: account, type: "chatgpt", planType: null, status: "active", dailyGuardEnabled: true, addedAt: "" };
    spies.push(spyOn(accounts, "resolveCodexAccountForSession").mockResolvedValue(acct as accounts.CodexAccount));
    spies.push(spyOn(CodexJsonRpcClient.prototype, "start").mockImplementation((opts?: { codexHome?: string }) => { started.push(opts ?? {}); }));
    spies.push(spyOn(CodexJsonRpcClient.prototype, "notify").mockImplementation(() => {}));
    spies.push(spyOn(CodexJsonRpcClient.prototype, "close").mockImplementation(() => {}));
    spies.push(spyOn(CodexJsonRpcClient.prototype, "request").mockImplementation(async (method: string, value: any) => {
      if (method === "config/read") return { config: {} };
      if (method === "skills/list") return { data: [{ skills: [{ name: "ak-advise" }] }] };
      if (method === "thread/start") { threadStarts.push(value); return { thread: { id: `thread-${crypto.randomUUID()}` } }; }
      return {};
    }));
  });

  afterEach(() => {
    configService.set("ai", previousAi);
    spies.splice(0).forEach((spy) => spy.mockRestore());
  });

  it("spawns on the Assistant's own home and switches off the skills it can see", async () => {
    const provider = new CodexAppServerProvider();
    try {
      await (provider as any).connect((await provider.createSession({})).id, { assistantSession: true, assistantInstructions: "# PPM Assistant" });
      expect(started[0]!.codexHome!.startsWith(assistantCodexHomesRoot())).toBe(true);
      expect(sameFile(join(started[0]!.codexHome!, "auth.json"), join(account, "auth.json"))).toBe(true);
      expect(threadStarts[0]!.config["skills.config"]).toEqual([{ name: "ak-advise", enabled: false }]);
    } finally { provider.cleanupAll(); }
  });

  it("leaves an ordinary session on the account's own home", async () => {
    const provider = new CodexAppServerProvider();
    try {
      await (provider as any).connect((await provider.createSession({})).id, {});
      expect(started[0]!.codexHome).toBe(account);
    } finally { provider.cleanupAll(); }
  });
});
