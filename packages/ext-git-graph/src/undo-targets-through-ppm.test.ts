/**
 * The Git Graph's two Undos name what they undo. "Undo last commit" sends the
 * commit the panel showed, so PPM refuses once something else has landed on
 * top of it; Stash answers with the stash PPM says it made, never the one on
 * top of the list, which is an older one when git found nothing it could save.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@ppm/vscode-compat";
import { activate } from "./extension.ts";
import { _resetPanelRegistry } from "./panel-registry.ts";

type Posted = { command: string; action?: string; result?: { ok: boolean; data?: unknown; error?: string } };

const HASH = "0123456789abcdef0123456789abcdef01234567";
const OLDER = { index: 0, hash: "f".repeat(40), message: "older" };

let repo: string;
let posted: Posted[] = [];
let requests: { method: string; url: string; body?: string }[] = [];
let stashAnswer: unknown = null;
let send: (msg: unknown) => void = () => {};
let dispose: () => void = () => {};
const realFetch = globalThis.fetch;
const realSetInterval = globalThis.setInterval;

function git(...args: string[]): void {
  const r = Bun.spawnSync(["git", "-c", "user.name=T", "-c", "user.email=t@e.x", ...args], { cwd: repo });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

const envelope = (data: unknown) => new Response(JSON.stringify({ ok: true, data }), { headers: { "Content-Type": "application/json" } });

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out; posted: " + posted.map((m) => m.command).join(", "));
    await new Promise((r) => setTimeout(r, 10));
  }
}

const answerTo = (action: string) => posted.find((m) => m.command === "actionResult" && m.action === action);
const posts = (route: string) => requests
  .filter((r) => r.method === "POST" && r.url.endsWith(`/api/project/demo/git${route}`))
  .map((r) => (r.body ? JSON.parse(r.body) : undefined));

beforeEach(async () => {
  posted = [];
  requests = [];
  stashAnswer = null;
  repo = mkdtempSync(join(tmpdir(), "gg-undo-"));
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "one\n");
  git("add", "a.txt");
  git("commit", "-qm", "one");

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({ method: init?.method ?? "GET", url, body: typeof init?.body === "string" ? init.body : undefined });
    if (url.endsWith("/api/projects")) return envelope([{ name: "demo", path: repo }]);
    if (url.includes("/api/project/demo/git/commit/undo")) return envelope({ hash: HASH, message: "m", draft: { message: "m", updatedAt: null } });
    if (url.includes("/api/project/demo/git/stashes")) return envelope([OLDER]);
    if (url.includes("/api/project/demo/git/stash")) return envelope(stashAnswer);
    if (url.includes("/api/project/demo/git/changes")) return envelope({ branch: { head: "main", oid: "x", ahead: 0, behind: 0 }, files: [] });
    return new Response(JSON.stringify({ ok: false, error: "not in this test" }), { status: 503 });
  }) as typeof fetch;
  // The five-second poll is not what is under test.
  globalThis.setInterval = (() => 0) as unknown as typeof setInterval;

  const commands = new Map<string, (...args: unknown[]) => unknown>();
  const vscode = {
    commands: {
      registerCommand(id: string, cb: (...args: unknown[]) => unknown) {
        commands.set(id, cb);
        return { dispose() {} };
      },
    },
    window: {
      async showErrorMessage() { return undefined; },
      async showInformationMessage() { return undefined; },
      async openTab() {},
      async switchProject() {},
      createWebviewPanel() {
        const onDispose: (() => void)[] = [];
        const panel = {
          webview: {
            html: "",
            onDidReceiveMessage(listener: (msg: unknown) => void) {
              send = listener;
              return { dispose() {} };
            },
            async postMessage(message: Posted) {
              posted.push(message);
              return true;
            },
          },
          onDidDispose(listener: () => void) {
            onDispose.push(listener);
            return { dispose() {} };
          },
          dispose() {
            for (const l of onDispose.splice(0)) l();
          },
        };
        dispose = () => panel.dispose();
        return panel;
      },
    },
    process: {
      async spawn(cmd: string, args: string[], cwd: string) {
        const p = Bun.spawn([cmd, ...args], { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
        const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
        return { stdout, stderr, exitCode: await p.exited };
      },
    },
    ViewColumn: { Active: 1 },
  };
  const state = new Map<string, unknown>();
  const context = {
    subscriptions: [],
    globalState: { get: (key: string) => state.get(key), update: async (key: string, value: unknown) => { state.set(key, value); } },
  } as unknown as ExtensionContext;
  activate(context, vscode as never);
  await commands.get("git-graph.view")!(repo);
  send({ command: "ready" });
  await until(() => posted.some((m) => m.command === "loadCommits"));
});

afterEach(() => {
  dispose();
  _resetPanelRegistry();
  globalThis.fetch = realFetch;
  globalThis.setInterval = realSetInterval;
  // The re-read after an answer can still have git running in it, and Windows refuses to delete under it.
  try { rmSync(repo, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe("Undo last commit", () => {
  it("asks PPM to undo the commit the panel named", async () => {
    send({ command: "undoCommit", hash: HASH });
    await until(() => !!answerTo("undoCommit"));
    expect(answerTo("undoCommit")!.result!.ok).toBe(true);
    expect(posts("/commit/undo")).toEqual([{ hash: HASH }]);
  });
});

describe("Stash", () => {
  it("answers with the stash PPM made", async () => {
    stashAnswer = { stashed: true, stash: { index: 0, hash: HASH, message: "mine" } };
    send({ command: "stash", message: "mine", includeUntracked: true });
    await until(() => !!answerTo("stash"));
    expect(answerTo("stash")!.result).toEqual({ ok: true, data: { index: 0, hash: HASH, message: "mine" } });
  });

  it("fails, offering no Undo, when nothing was stashed", async () => {
    // The list's top is an older stash: popping it would bring back work set aside long ago.
    stashAnswer = { stashed: false, stash: null };
    send({ command: "stash", includeUntracked: false });
    await until(() => !!answerTo("stash"));
    expect(answerTo("stash")!.result).toEqual({ ok: false, error: expect.stringMatching(/^Nothing was stashed/) });
  });
});
