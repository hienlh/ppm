/**
 * For tests only: the Git Graph's two halves, each run for real.
 *
 * `openPanelHost` opens a panel through `activate` on a scratch repository, the
 * way the app opens one, with PPM's git routes answered by the test and the
 * five-second poll never started. It returns once everything `ready` starts has
 * answered, and `close` waits for every git child the panel started before it
 * deletes the repository — Windows refuses while one still runs in it.
 *
 * `openPanelPage` runs the shipped webview script in a DOM, with the test as the
 * host: what the page sends lands in `posted`, and `send` delivers a message to it.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Window } from "happy-dom";
import type { ExtensionContext } from "@ppm/vscode-compat";
import { activate } from "./extension.ts";
import { _resetPanelRegistry } from "./panel-registry.ts";
import { getWebviewHtml } from "./webview-html.ts";

/** A message between the halves. */
export type Message = { command: string } & Record<string, any>;

/** Answers one call to PPM's git routes (`/changes`, `/commit` …); undefined is "not in this test". */
export type Route = (method: string, path: string, body: any) => Response | undefined | Promise<Response | undefined>;

export const envelope = (data: unknown): Response =>
  new Response(JSON.stringify({ ok: true, data }), { headers: { "Content-Type": "application/json" } });

async function until(check: () => boolean, describe: () => string, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out; " + describe());
    await new Promise((r) => setTimeout(r, 10));
  }
}

export interface PanelHost {
  repo: string;
  /** What the host posted to the panel, in order. */
  posted: Message[];
  /** The calls the host made to PPM's git routes, in order. */
  calls: { method: string; path: string; body: any }[];
  /** The arguments of every git child the host started, in order. */
  spawned: string[][];
  send(msg: unknown): void;
  sent(command: string): Message[];
  until(check: () => boolean, ms?: number): Promise<void>;
  /** git in the scratch repository; its output. */
  git(...args: string[]): string;
  close(): Promise<void>;
}

export async function openPanelHost(route: Route = () => undefined): Promise<PanelHost> {
  const repo = mkdtempSync(join(tmpdir(), "gg-host-"));
  const posted: Message[] = [];
  const calls: PanelHost["calls"] = [];
  const spawned: string[][] = [];
  const running = new Set<Promise<unknown>>();
  let send: (msg: unknown) => void = () => {};
  let dispose = () => {};

  const git = (...args: string[]): string => {
    const r = Bun.spawnSync(["git", "-c", "user.name=T", "-c", "user.email=t@e.x", ...args], { cwd: repo });
    if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.toString();
  };
  git("init", "-q", "-b", "main");
  git("config", "core.autocrlf", "false");
  writeFileSync(join(repo, "a.txt"), "one\n");
  git("add", "a.txt");
  git("commit", "-qm", "one");

  const realFetch = globalThis.fetch;
  const realSetInterval = globalThis.setInterval;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    // Relative when the test process has no port configured: the base is irrelevant here.
    const url = new URL(String(input), "http://ppm.invalid");
    if (url.pathname === "/api/projects") return envelope([{ name: "demo", path: repo }]);
    const prefix = "/api/project/demo/git";
    if (url.pathname.startsWith(prefix)) {
      const method = init?.method ?? "GET";
      const path = url.pathname.slice(prefix.length);
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ method, path, body });
      const answer = await route(method, path, body);
      if (answer) return answer;
    }
    return new Response(JSON.stringify({ ok: false, error: "not in this test" }), { status: 503 });
  }) as typeof fetch;
  // The five-second poll is not what these tests are about.
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
            async postMessage(message: Message) {
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
      spawn(cmd: string, args: string[], cwd: string) {
        spawned.push(args);
        const child = Bun.spawn([cmd, ...args], { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
        const done = (async () => {
          const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
          return { stdout, stderr, exitCode: await child.exited };
        })();
        running.add(done);
        done.then(() => running.delete(done), () => running.delete(done));
        return done;
      },
    },
    ViewColumn: { Active: 1 },
  };
  const stored = new Map<string, unknown>();
  const context = {
    subscriptions: [],
    globalState: {
      get: (key: string) => stored.get(key),
      update: async (key: string, value: unknown) => { stored.set(key, value); },
    },
  } as unknown as ExtensionContext;

  activate(context, vscode as never);
  await commands.get("git-graph.view")!(repo);
  globalThis.setInterval = realSetInterval;

  const sent = (command: string) => posted.filter((m) => m.command === command);
  const wait = (check: () => boolean, ms?: number) => until(check, () => "posted: " + posted.map((m) => m.command).join(", "), ms);
  send({ command: "ready" });
  await wait(() => ["loadCommits", "loadChanges", "loadWorktrees", "loadStashes", "loadSubmodules"].every((c) => sent(c).length > 0));

  return {
    repo,
    posted,
    calls,
    spawned,
    send: (msg) => send(msg),
    sent,
    until: wait,
    git,
    async close() {
      dispose();
      _resetPanelRegistry();
      globalThis.fetch = realFetch;
      // Quiet twice in a row: a re-read still in flight may start its next git child a moment later.
      for (let quiet = 0; quiet < 2;) {
        if (running.size) {
          quiet = 0;
          await Promise.allSettled([...running]);
        } else {
          quiet++;
          await new Promise((r) => setTimeout(r, 20));
        }
      }
      try {
        rmSync(repo, { recursive: true, force: true });
      } catch {
        // Best effort: a temp directory Windows still holds is not the test's failure.
      }
    },
  };
}

export interface PanelPage {
  window: Window;
  document: Document;
  /** What the page sent to its host, in order. */
  posted: Message[];
  /** A message from the host. */
  send(data: unknown): void;
  /** Any binding of the page's script, by name: `state`, `request`, `commitStaged` … */
  read<T = any>(name: string): T;
  close(): Promise<void>;
}

export function openPanelPage(): PanelPage {
  const html = getWebviewHtml();
  const start = html.lastIndexOf("<script>");
  const end = html.lastIndexOf("</script>");
  const script = html.slice(start + "<script>".length, end);
  const window = new Window({ url: "https://panel.invalid/", width: 1200, height: 800 });
  const document = window.document as unknown as Document;
  document.write(html.slice(0, start) + html.slice(end + "</script>".length));

  const posted: Message[] = [];
  const api = { postMessage: (m: Message) => posted.push(m) };
  const w = window as any;
  // The script's free globals, passed in: happy-dom's window is not this realm's global.
  const run = new Function(
    "document", "window", "navigator", "CSS", "setTimeout", "clearTimeout", "setInterval", "clearInterval",
    "ResizeObserver", "acquireVsCodeApi",
    script + "\n;return (name) => eval(name);",
  );
  const read = run(
    document, w, w.navigator, w.CSS, w.setTimeout.bind(w), w.clearTimeout.bind(w), w.setInterval.bind(w),
    w.clearInterval.bind(w), w.ResizeObserver, () => api,
  ) as (name: string) => any;

  return {
    window,
    document,
    posted,
    send: (data) => window.dispatchEvent(new window.MessageEvent("message", { data })),
    read: (name) => read(name),
    close: () => window.happyDOM.close(),
  };
}
