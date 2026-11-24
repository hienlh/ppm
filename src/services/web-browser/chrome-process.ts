/**
 * Starts PPM's Chrome, connects CDP to it, and stops it — including a Chrome a crashed PPM left
 * behind.
 *
 * On Windows a second Chrome on the same profile does not fail: it hands its arguments to the
 * running one and exits, so an orphan would silently swallow every later start. `chrome.pid.json`
 * records the root pid and its profile; at start, a live process whose command line still names
 * that profile is killed first (the command line, not the pid alone, because pids are reused).
 *
 * Stopping asks Chrome to close over CDP first so cookies reach the disk, then kills the tree
 * asynchronously. `killProcessTree` is not used: its `taskkill` runs synchronously with a
 * timeout, which fails at once inside a request after the server has idled — exactly when the
 * idle-stop timer fires (CLAUDE.md, "A sync spawn with a timeout fails at once").
 */
import { spawn as nodeSpawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import type { Readable, Writable } from "node:stream";
import { CdpConnection } from "./cdp-connection.ts";
import { pipeTransport, webSocketTransport } from "./cdp-transports.ts";
import { chromeLaunchArgs, type CdpTransportKind, webBrowserPaths } from "./chrome-launch-args.ts";
import { killChromeTree, processCommandLine } from "./chrome-process-tree.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("web-browser");

export interface RunningChrome {
  pid: number;
  cdp: CdpConnection;
  transport: CdpTransportKind;
  devtoolsPort: number | null;
  /** Resolves when the root process exits. */
  exited: Promise<number | null>;
}

export interface StartChromeInput {
  executable: string;
  egressPort: number;
  transport: CdpTransportKind;
  devtoolsPort?: number;
  audio: boolean;
}

/** A free TCP port on 127.0.0.1 (released before Chrome binds it). */
export function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

/** Kills a Chrome an earlier PPM left running on this profile. */
export async function killOrphanChrome(): Promise<void> {
  let record: { pid?: number; profileDir?: string };
  try { record = JSON.parse(readFileSync(webBrowserPaths.pidFile(), "utf8")); } catch { return; }
  if (typeof record.pid !== "number" || typeof record.profileDir !== "string") return;
  const cmd = await processCommandLine(record.pid);
  if (cmd && cmd.includes(record.profileDir)) {
    log.warn(`Stopping the browser (PID ${record.pid}) an earlier PPM left running`);
    await killChromeTree(record.pid);
  }
  try { rmSync(webBrowserPaths.pidFile(), { force: true }); } catch {}
}

/**
 * The browser's DevTools WebSocket URL, asked from `/json/version` on the loopback port. Chrome
 * writes `DevToolsActivePort` only when it picked the port itself (`=0`), and PPM names the port
 * up front so the egress guard can block it before Chrome starts.
 */
async function readDevtoolsUrl(port: number, deadline: number): Promise<string> {
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) {
        const url = ((await res.json()) as { webSocketDebuggerUrl?: string }).webSocketDebuggerUrl;
        if (url?.startsWith(`ws://127.0.0.1:${port}/`)) return url;
      }
    } catch {}
    await Bun.sleep(150);
  }
  throw new Error("Chrome did not open its DevTools port");
}

export async function startChrome(input: StartChromeInput): Promise<RunningChrome> {
  const profileDir = webBrowserPaths.profile();
  mkdirSync(profileDir, { recursive: true });
  const args = chromeLaunchArgs({ profileDir, ...input });
  const stdio = input.transport === "pipe"
    ? (["ignore", "ignore", "ignore", "pipe", "pipe"] as const)
    : (["ignore", "ignore", "ignore"] as const);
  // Chrome refuses remote debugging when USERPROFILE is not the account's real profile folder
  // (measured: "DevTools remote debugging requires a non-default data directory", whatever
  // --user-data-dir says). PPM never changes it; an isolated test sandbox does, and names the
  // real folder for Chrome here.
  const realProfile = process.env.PPM_WEB_BROWSER_CHROME_USERPROFILE;
  const env = realProfile ? { ...process.env, USERPROFILE: realProfile } : process.env;
  const child = nodeSpawn(input.executable, args, { stdio: [...stdio], windowsHide: true, env });
  if (!child.pid) throw new Error(`Could not start ${input.executable}`);
  const pid = child.pid;
  const exited = new Promise<number | null>((resolve) => {
    child.once("exit", (code) => resolve(code));
    child.once("error", () => resolve(null));
  });
  writeFileSync(webBrowserPaths.pidFile(), JSON.stringify({ pid, profileDir, startedAt: Date.now() }));
  try {
    const transport = input.transport === "pipe"
      ? pipeTransport(child.stdio[3] as Writable, child.stdio[4] as Readable)
      : await webSocketTransport(await readDevtoolsUrl(input.devtoolsPort!, Date.now() + 15_000));
    const cdp = new CdpConnection(transport);
    await Promise.race([
      cdp.send("Browser.getVersion"),
      Bun.sleep(8000).then(() => { throw new Error("Chrome did not answer over CDP"); }),
    ]);
    void exited.then(() => cdp.close());
    return { pid, cdp, transport: input.transport, devtoolsPort: input.devtoolsPort ?? null, exited };
  } catch (error) {
    await killChromeTree(pid);
    throw error;
  }
}

/** Close politely, then make sure the whole tree is gone. */
export async function stopChrome(chrome: RunningChrome): Promise<void> {
  try {
    await Promise.race([chrome.cdp.send("Browser.close"), Bun.sleep(3000)]);
  } catch {}
  const exitedInTime = await Promise.race([chrome.exited.then(() => true), Bun.sleep(5000).then(() => false)]);
  if (!exitedInTime) await killChromeTree(chrome.pid);
  chrome.cdp.close();
  try { rmSync(webBrowserPaths.pidFile(), { force: true }); } catch {}
}
