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
import { join } from "node:path";
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

async function readDevtoolsPath(profileDir: string, deadline: number): Promise<string> {
  while (Date.now() < deadline) {
    try {
      const [port, path] = readFileSync(join(profileDir, "DevToolsActivePort"), "utf8").split(/\r?\n/);
      if (port && path) return `ws://127.0.0.1:${port}${path}`;
    } catch {}
    await Bun.sleep(100);
  }
  throw new Error("Chrome did not open its DevTools port");
}

export async function startChrome(input: StartChromeInput): Promise<RunningChrome> {
  const profileDir = webBrowserPaths.profile();
  mkdirSync(profileDir, { recursive: true });
  // A stale file from a crashed run would point at a port nobody listens on any more.
  try { rmSync(join(profileDir, "DevToolsActivePort"), { force: true }); } catch {}
  const args = chromeLaunchArgs({ profileDir, ...input });
  const stdio = input.transport === "pipe"
    ? (["ignore", "ignore", "ignore", "pipe", "pipe"] as const)
    : (["ignore", "ignore", "ignore"] as const);
  const child = nodeSpawn(input.executable, args, { stdio: [...stdio], windowsHide: true });
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
      : await webSocketTransport(await readDevtoolsPath(profileDir, Date.now() + 15_000));
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
