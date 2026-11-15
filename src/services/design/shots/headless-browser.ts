import { spawn as spawnChild } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killProcessTree } from "../../windows-process-tree.ts";

/**
 * A Chromium-family browser already on this machine, driven headless over the DevTools protocol,
 * to render a design page to PNG on the server. PPM ships no browser: Windows always has Edge,
 * and a Mac or Linux desktop usually has Chrome, Chromium or Edge. `PPM_HEADLESS_BROWSER` names
 * one explicitly. With none found, a screenshot is refused with that reason rather than faked.
 *
 * Each run gets a fresh, empty profile in a temporary folder (no cookies, no extensions, nothing
 * of the user's own browser) and kills exactly the process it started — by its pid, with its own
 * children on Windows.
 *
 * DevTools is reached over `--remote-debugging-pipe` (fds 3 and 4, NUL-framed JSON) where that
 * works, so no other process on the machine can connect to it, and the browser exits when PPM
 * does. That is Linux and macOS: on Windows, Bun does not hand a child any descriptor past
 * stdio (measured: Edge never answers on the pipe), so there the browser listens on a loopback
 * port it picks itself (`--remote-debugging-port=0`, read from `DevToolsActivePort`), open only
 * for the seconds one capture takes. A pipe that does not answer at start falls back to the port.
 */

const CANDIDATES: Record<string, () => string[]> = {
  win32: () => {
    const roots = [process.env["ProgramFiles(x86)"], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean) as string[];
    return roots.flatMap((root) => [
      join(root, "Microsoft", "Edge", "Application", "msedge.exe"),
      join(root, "Google", "Chrome", "Application", "chrome.exe"),
      join(root, "Chromium", "Application", "chrome.exe"),
    ]);
  },
  darwin: () => [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ],
};
const PATH_NAMES = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "microsoft-edge-stable"];

/** The browser binary to use, or null when this machine has none PPM knows how to find. */
export function findHeadlessBrowser(env: NodeJS.ProcessEnv = process.env): string | null {
  const named = env.PPM_HEADLESS_BROWSER?.trim();
  if (named) return existsSync(named) ? named : null;
  for (const path of CANDIDATES[process.platform]?.() ?? []) if (existsSync(path)) return path;
  for (const name of PATH_NAMES) {
    const found = Bun.which(name);
    if (found) return found;
  }
  return null;
}

export const NO_BROWSER_MESSAGE =
  "No Chrome, Edge or Chromium was found on the machine PPM runs on, so PPM cannot render the design to PNG. "
  + "Install one, or set PPM_HEADLESS_BROWSER to its path.";

type Pending = { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void };

/** One DevTools connection: commands by id, events by name. */
export class CdpConnection {
  private next = 1;
  private pending = new Map<number, Pending>();
  private listeners = new Set<(method: string, params: Record<string, unknown>, sessionId?: string) => void>();

  private constructor(private readonly write: (raw: string) => void, private readonly shut: () => void) {}

  /** One message from the browser, whichever way it came. */
  private receive(raw: string): void {
    let msg: { id?: number; result?: Record<string, unknown>; error?: { message?: string }; method?: string; params?: Record<string, unknown>; sessionId?: string };
    try { msg = JSON.parse(raw); } catch { return; }
    if (typeof msg.id === "number") {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message ?? "DevTools error"));
      else p.resolve(msg.result ?? {});
    } else if (msg.method) {
      for (const l of [...this.listeners]) l(msg.method, msg.params ?? {}, msg.sessionId);
    }
  }

  /** DevTools over a WebSocket (the loopback port). */
  static open(url: string, timeoutMs: number): Promise<CdpConnection> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const conn = new CdpConnection((raw) => ws.send(raw), () => { try { ws.close(); } catch { /* closed */ } });
      const timer = setTimeout(() => { ws.close(); reject(new Error("The browser's DevTools did not answer")); }, timeoutMs);
      ws.addEventListener("message", (ev) => conn.receive(String(ev.data)));
      ws.addEventListener("close", () => conn.fail(new Error("The browser closed the DevTools connection")));
      ws.addEventListener("open", () => { clearTimeout(timer); resolve(conn); });
      ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Could not connect to the browser's DevTools")); });
    });
  }

  /** DevTools over `--remote-debugging-pipe`: JSON messages, each ended by a NUL byte. */
  static overPipe(toBrowser: NodeJS.WritableStream, fromBrowser: NodeJS.ReadableStream): CdpConnection {
    const conn = new CdpConnection((raw) => { toBrowser.write(`${raw}\0`); }, () => { try { toBrowser.end(); } catch { /* closed */ } });
    let buffered = "";
    fromBrowser.on("data", (chunk: Buffer | string) => {
      buffered += chunk.toString();
      let end: number;
      while ((end = buffered.indexOf("\0")) >= 0) {
        conn.receive(buffered.slice(0, end));
        buffered = buffered.slice(end + 1);
      }
    });
    fromBrowser.on("close", () => conn.fail(new Error("The browser closed the DevTools pipe")));
    toBrowser.on("error", () => conn.fail(new Error("The DevTools pipe broke")));
    fromBrowser.on("error", () => conn.fail(new Error("The DevTools pipe broke")));
    return conn;
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = 20_000): Promise<Record<string, unknown>> {
    // A closed connection answers at once rather than leaving the caller to its timeout.
    if (this.failed) return Promise.reject(this.failed);
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      try {
        this.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(e as Error);
      }
    });
  }

  /**
   * Resolves with the first `method` event of `sessionId`; rejects after `timeoutMs` or when the
   * connection closes. Never left unhandled: a caller that stops waiting (the navigation it was
   * for failed) must not leave a rejection behind, which the server counts towards exiting.
   */
  waitFor(method: string, sessionId: string | undefined, timeoutMs: number): Promise<Record<string, unknown>> {
    const waiting = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => { done(); reject(new Error(`${method} did not arrive`)); }, timeoutMs);
      const listener = (m: string, params: Record<string, unknown>, sid?: string) => {
        if (m !== method || sid !== sessionId) return;
        done();
        resolve(params);
      };
      const abandon = (e: Error) => { done(); reject(e); };
      const done = () => { clearTimeout(timer); this.listeners.delete(listener); this.waiters.delete(abandon); };
      this.listeners.add(listener);
      this.waiters.add(abandon);
    });
    waiting.catch(() => {});
    return waiting;
  }

  /** Calls `handler` for every `method` event of `sessionId` until the returned function is called. */
  on(method: string, sessionId: string, handler: (params: Record<string, unknown>) => void): () => void {
    const listener = (m: string, params: Record<string, unknown>, sid?: string) => {
      if (m === method && sid === sessionId) handler(params);
    };
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private waiters = new Set<(e: Error) => void>();
  private failed: Error | null = null;

  /** Rejects every command and event wait still open, and every later one. */
  private fail(e: Error): void {
    this.failed ??= e;
    for (const p of this.pending.values()) p.reject(e);
    this.pending.clear();
    for (const abandon of [...this.waiters]) abandon(e);
    this.listeners.clear();
  }

  close(): void {
    this.fail(new Error("The DevTools connection was closed"));
    this.shut();
  }
}

export interface HeadlessBrowser {
  cdp: CdpConnection;
  /** How DevTools is reached: the private pipe, or the loopback port (Windows, or a pipe that did not answer). */
  transport: "pipe" | "port";
  /** Stops the browser and removes its temporary profile; never throws. */
  close(): Promise<void>;
}

const START_TIMEOUT_MS = 15_000;
const PIPE_HELLO_MS = 5_000;

const BASE_ARGS = [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--hide-scrollbars",
  "--disable-extensions", "--disable-sync", "--disable-background-networking", "--mute-audio",
  // Chromium refuses to start as root with its sandbox on (PPM in a container, say).
  ...(process.getuid?.() === 0 ? ["--no-sandbox"] : []),
];

/** The started browser as both ways of starting it expose it. */
interface Started { pid: number; exited: Promise<unknown>; done: () => boolean; kill: () => void }

/** Stops the browser and removes its profile; never throws. */
async function stop(started: Started, profile: string, cdp?: CdpConnection): Promise<void> {
  try { await cdp?.send("Browser.close", {}, undefined, 3000); } catch { /* killed below */ }
  cdp?.close();
  const exited = await Promise.race([started.exited.then(() => true), Bun.sleep(3000).then(() => false)]);
  if (!exited && !started.done()) {
    // Only the browser this call started, with its own child processes: never by image name.
    if (process.platform === "win32") killProcessTree(started.pid);
    else started.kill();
    await Promise.race([started.exited, Bun.sleep(3000)]);
  }
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}

/** Over the pipe; null when it does not answer, the browser already stopped and its profile gone. */
async function launchOverPipe(binary: string): Promise<HeadlessBrowser | null> {
  const profile = await mkdtemp(join(tmpdir(), "ppm-design-shot-"));
  const child = spawnChild(binary, [...BASE_ARGS, `--user-data-dir=${profile}`, "--remote-debugging-pipe", "about:blank"], {
    stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
  });
  const exited = new Promise((resolve) => { child.once("exit", resolve); child.once("error", resolve); });
  const started: Started = {
    pid: child.pid ?? 0, exited,
    done: () => child.exitCode !== null || child.signalCode !== null,
    kill: () => { child.kill("SIGKILL"); },
  };
  const cdp = CdpConnection.overPipe(child.stdio[3] as NodeJS.WritableStream, child.stdio[4] as NodeJS.ReadableStream);
  try {
    await cdp.send("Browser.getVersion", {}, undefined, PIPE_HELLO_MS);
  } catch {
    await stop(started, profile, cdp);
    return null;
  }
  let closed = false;
  return { cdp, transport: "pipe", close: async () => { if (closed) return; closed = true; await stop(started, profile, cdp); } };
}

/** Over a loopback port the browser picks, read from `DevToolsActivePort`. */
async function launchOverPort(binary: string): Promise<HeadlessBrowser> {
  const profile = await mkdtemp(join(tmpdir(), "ppm-design-shot-"));
  const proc = Bun.spawn([binary, ...BASE_ARGS, `--user-data-dir=${profile}`, "--remote-debugging-port=0", "about:blank"], {
    stdout: "ignore", stderr: "ignore", stdin: "ignore",
  });
  const started: Started = { pid: proc.pid, exited: proc.exited, done: () => proc.exitCode !== null, kill: () => proc.kill("SIGKILL") };
  try {
    const deadline = Date.now() + START_TIMEOUT_MS;
    let wsPath: string | null = null;
    let port = 0;
    while (Date.now() < deadline) {
      if (proc.exitCode !== null) throw new Error(`The browser exited at start (code ${proc.exitCode})`);
      const text = await readFile(join(profile, "DevToolsActivePort"), "utf8").catch(() => null);
      const [p, path] = text?.split(/\r?\n/) ?? [];
      if (p && path) { port = Number(p); wsPath = path; break; }
      await Bun.sleep(100);
    }
    if (!wsPath || !port) throw new Error("The browser did not open DevTools in time");
    const cdp = await CdpConnection.open(`ws://127.0.0.1:${port}${wsPath}`, 5000);
    let closed = false;
    return { cdp, transport: "port", close: async () => { if (closed) return; closed = true; await stop(started, profile, cdp); } };
  } catch (e) {
    await stop(started, profile);
    throw e;
  }
}

/** Starts `binary` headless with an empty profile and connects to it (see the module comment). */
export async function launchHeadlessBrowser(binary: string): Promise<HeadlessBrowser> {
  if (process.platform !== "win32") {
    const piped = await launchOverPipe(binary);
    if (piped) return piped;
  }
  return launchOverPort(binary);
}
