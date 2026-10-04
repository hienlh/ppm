/**
 * A stash, branch or tag changed outside the panel — in a terminal, by another
 * tool — reached the graph only through View → Refresh: the five-second poll
 * read the working tree and nothing else, and none of those move HEAD. The poll
 * now also reads the refs and the stash list, and reads the rest again when
 * either has moved.
 *
 * Driven through `activate` with real git underneath. The poll's tick is caught
 * when the panel sets it and called by hand, so nothing here waits five seconds.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@ppm/vscode-compat";
import { activate } from "./extension.ts";
import { _resetPanelRegistry } from "./panel-registry.ts";

type Posted = { command: string; data?: { branches?: { name: string }[]; stashes?: unknown[] } };

let repo: string;
let posted: Posted[] = [];
let send: (msg: unknown) => void = () => {};
let tick: (() => void) | null = null;
let dispose: () => void = () => {};
const realSetInterval = globalThis.setInterval;
const realFetch = globalThis.fetch;

function git(...args: string[]): void {
  const r = Bun.spawnSync(["git", "-c", "user.name=T", "-c", "user.email=t@e.x", ...args], { cwd: repo });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

function fakeVscode(commands: Map<string, (...args: unknown[]) => unknown>) {
  return {
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
}

function fakeContext(): ExtensionContext {
  const state = new Map<string, unknown>();
  return {
    subscriptions: [],
    globalState: {
      get: <T>(key: string) => state.get(key) as T | undefined,
      update: async (key: string, value: unknown) => { state.set(key, value); },
    },
  } as unknown as ExtensionContext;
}

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out; posted: " + posted.map((m) => m.command).join(", "));
    await new Promise((r) => setTimeout(r, 10));
  }
}

const sent = (command: string) => posted.filter((m) => m.command === command);

/** One poll, run to the end: the working tree's answer is always the last thing it posts. */
async function poll(): Promise<void> {
  posted = [];
  tick!();
  await until(() => sent("loadChanges").length > 0);
}

beforeEach(async () => {
  // Left over from the last test, the old messages would answer the wait below at once.
  posted = [];
  repo = mkdtempSync(join(tmpdir(), "gg-outside-refs-"));
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "one\n");
  git("add", "a.txt");
  git("commit", "-qm", "one");

  // No PPM behind this panel: the working tree's read fails fast, which is still an answer.
  globalThis.fetch = (async () => new Response(JSON.stringify({ ok: false, error: "no PPM" }), { status: 503 })) as unknown as typeof fetch;
  globalThis.setInterval = ((fn: () => void) => {
    tick = fn;
    return 0;
  }) as unknown as typeof setInterval;
  const commands = new Map<string, (...args: unknown[]) => unknown>();
  activate(fakeContext(), fakeVscode(commands) as never);
  await commands.get("git-graph.view")!(repo);
  globalThis.setInterval = realSetInterval;

  send({ command: "ready" });
  // Everything `ready` starts, the three lists it does not wait for included: a git child
  // still running in the repository would keep Windows from deleting it after the test.
  await until(() => ["loadCommits", "loadChanges", "loadWorktrees", "loadStashes", "loadSubmodules"]
    .every((command) => sent(command).length > 0));
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

describe("the panel's poll", () => {
  it("reads nothing more when no ref has moved", async () => {
    await poll();
    expect(sent("loadRepoInfo")).toHaveLength(0);
    expect(sent("loadCommits")).toHaveLength(0);
  });

  it("reads the stash list and the history again after a stash made outside", async () => {
    writeFileSync(join(repo, "a.txt"), "two\n");
    git("stash", "push", "-q", "-m", "from a terminal");
    await poll();
    expect(sent("loadRepoInfo").at(-1)!.data!.stashes).toHaveLength(1);
    expect(sent("loadCommits").length).toBeGreaterThan(0);
  });

  it("follows a stash dropped from below the top, which leaves refs/stash where it was", async () => {
    for (const text of ["two\n", "three\n"]) {
      writeFileSync(join(repo, "a.txt"), text);
      git("stash", "push", "-q");
    }
    await poll();
    git("stash", "drop", "-q", "stash@{1}");
    await poll();
    expect(sent("loadRepoInfo").at(-1)!.data!.stashes).toHaveLength(1);
  });

  it("follows a branch made outside, though HEAD did not move", async () => {
    git("branch", "feature");
    await poll();
    expect(sent("loadRepoInfo").at(-1)!.data!.branches!.map((b) => b.name)).toEqual(["feature", "main"]);
    // Once read, the same refs are not read again.
    await poll();
    expect(sent("loadRepoInfo")).toHaveLength(0);
  });
});
