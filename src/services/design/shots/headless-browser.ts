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
 * of the user's own browser), talks to it through the port it writes to `DevToolsActivePort`,
 * and kills exactly the process it started — by its pid, with its own children on Windows.
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

  private constructor(private ws: WebSocket) {
    ws.addEventListener("message", (ev) => {
      let msg: { id?: number; result?: Record<string, unknown>; error?: { message?: string }; method?: string; params?: Record<string, unknown>; sessionId?: string };
      try { msg = JSON.parse(String(ev.data)); } catch { return; }
      if (typeof msg.id === "number") {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message ?? "DevTools error"));
        else p.resolve(msg.result ?? {});
      } else if (msg.method) {
        for (const l of this.listeners) l(msg.method, msg.params ?? {}, msg.sessionId);
      }
    });
    ws.addEventListener("close", () => this.fail(new Error("The browser closed the DevTools connection")));
  }

  static open(url: string, timeoutMs: number): Promise<CdpConnection> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => { ws.close(); reject(new Error("The browser's DevTools did not answer")); }, timeoutMs);
      ws.addEventListener("open", () => { clearTimeout(timer); resolve(new CdpConnection(ws)); });
      ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Could not connect to the browser's DevTools")); });
    });
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = 20_000): Promise<Record<string, unknown>> {
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
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
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

  /** Rejects every command and event wait still open. */
  private fail(e: Error): void {
    for (const p of this.pending.values()) p.reject(e);
    this.pending.clear();
    for (const abandon of [...this.waiters]) abandon(e);
    this.listeners.clear();
  }

  close(): void {
    this.fail(new Error("The DevTools connection was closed"));
    try { this.ws.close(); } catch { /* already closed */ }
  }
}

export interface HeadlessBrowser {
  cdp: CdpConnection;
  /** Stops the browser and removes its temporary profile; never throws. */
  close(): Promise<void>;
}

const START_TIMEOUT_MS = 15_000;

/** Starts `binary` headless with an empty profile and connects to it. */
export async function launchHeadlessBrowser(binary: string): Promise<HeadlessBrowser> {
  const profile = await mkdtemp(join(tmpdir(), "ppm-design-shot-"));
  const proc = Bun.spawn([
    binary, "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--hide-scrollbars",
    "--disable-extensions", "--disable-sync", "--disable-background-networking", "--mute-audio",
    // Chromium refuses to start as root with its sandbox on (PPM in a container, say).
    ...(process.getuid?.() === 0 ? ["--no-sandbox"] : []),
    `--user-data-dir=${profile}`, "--remote-debugging-port=0", "about:blank",
  ], { stdout: "ignore", stderr: "ignore", stdin: "ignore" });

  let closed = false;
  const close = async (cdp?: CdpConnection): Promise<void> => {
    if (closed) return;
    closed = true;
    try { await cdp?.send("Browser.close", {}, undefined, 3000); } catch { /* killed below */ }
    cdp?.close();
    const exited = await Promise.race([proc.exited.then(() => true), Bun.sleep(3000).then(() => false)]);
    if (!exited) {
      // Only the browser this call started, with its own child processes: never by image name.
      if (process.platform === "win32") killProcessTree(proc.pid);
      else proc.kill("SIGKILL");
      await Promise.race([proc.exited, Bun.sleep(3000)]);
    }
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  };

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
    return { cdp, close: () => close(cdp) };
  } catch (e) {
    await close();
    throw e;
  }
}
