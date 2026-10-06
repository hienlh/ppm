/**
 * The toolbar's Fetch goes through PPM's own route, never `git fetch` on its
 * own. Run directly, it moved the remote branches with nobody told: the app's
 * status bar went on saying "synced" until its next poll, up to ten seconds
 * later. Through the route, every git surface hears `git:changed` at once.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@ppm/vscode-compat";
import { activate } from "./extension.ts";
import { _resetPanelRegistry } from "./panel-registry.ts";

type Posted = { command: string; action?: string; result?: { ok: boolean; data?: unknown; error?: string } };

let repo: string;
let posted: Posted[] = [];
let spawned: string[][] = [];
let requests: { method: string; url: string; body?: string }[] = [];
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

beforeEach(async () => {
  posted = [];
  spawned = [];
  requests = [];
  repo = mkdtempSync(join(tmpdir(), "gg-fetch-"));
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "one\n");
  git("add", "a.txt");
  git("commit", "-qm", "one");

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({ method: init?.method ?? "GET", url, body: typeof init?.body === "string" ? init.body : undefined });
    if (url.endsWith("/api/projects")) return envelope([{ name: "demo", path: repo }]);
    if (url.includes("/api/project/demo/git/fetch")) return envelope({ fetched: true });
    if (url.includes("/api/project/demo/git/changes")) return envelope({ branch: { head: "main", oid: "x", ahead: 0, behind: 2 }, files: [] });
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
        spawned.push(args);
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
  // Everything `ready` starts, the three lists it does not wait for included: a git child
  // still running in the repository would keep Windows from deleting it after the test.
  await until(() => ["loadCommits", "loadChanges", "loadWorktrees", "loadStashes", "loadSubmodules"]
    .every((command) => posted.some((m) => m.command === command)));
});

afterEach(() => {
  dispose();
  _resetPanelRegistry();
  globalThis.fetch = realFetch;
  globalThis.setInterval = realSetInterval;
  try {
    rmSync(repo, { recursive: true, force: true });
  } catch {
    // Best effort: a temp directory Windows still holds is not this test's failure.
  }
});

describe("the toolbar's Fetch", () => {
  it("asks PPM to fetch every remote, pruned, and answers with how far behind that left the branch", async () => {
    spawned = [];
    requests = [];
    send({ command: "sync", action: "fetch" });
    await until(() => posted.some((m) => m.command === "actionResult" && m.action === "fetch"));

    const answer = posted.find((m) => m.command === "actionResult" && m.action === "fetch")!;
    expect(answer.result).toEqual({ ok: true, data: { behind: 2 } });
    // The re-read the answer starts ends with the working tree; its git children are done by then.
    await until(() => posted.slice(posted.indexOf(answer)).some((m) => m.command === "loadChanges"));
    const post = requests.filter((r) => r.method === "POST");
    expect(post.map((r) => [r.url.replace(/^https?:\/\/[^/]+/, ""), r.body])).toEqual([["/api/project/demo/git/fetch", '{"prune":true}']]);
    expect(spawned.filter((args) => args.includes("fetch"))).toEqual([]);
  });
});
