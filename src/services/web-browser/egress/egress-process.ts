import { resolve } from "node:path";
import type { Subprocess } from "bun";
import { isCompiledBinary } from "../../autostart-generator.ts";
import { createLogger } from "../../logger.ts";
import type { EgressBlockReason } from "../address-policy.ts";

/**
 * Starts and watches the egress proxy process (`egress-main.ts`) for one browser session.
 *
 * The server keeps the child's stdin open for as long as it wants the proxy; the child exits when
 * it closes, so a server that dies never leaves a proxy behind. `exited` settles when the child
 * is gone for any reason, so the caller can take Chrome down with it.
 */

export { EGRESS_CANARY_HOST } from "./socks5-server.ts";
export type { EgressBlockReason } from "../address-policy.ts";

const log = createLogger("web-egress");
const READY_TIMEOUT_MS = 5000;
const STOP_GRACE_MS = 2000;
const BLOCK_REPORT_EVERY_MS = 5000;
const lastReported = new Map<string, number>();
const REASONS: EgressBlockReason[] = ["private-address", "own-port", "metadata", "dns-failed", "public-name-inward"];

export interface EgressOptions {
  allowLocalhost: boolean;
  allowLan: boolean;
  /** PPM, supervisor, edge, relay and Chrome DevTools ports: refused on every address of this machine. */
  blockedLocalPorts: number[];
  /** PPM's own public host names, refused by name. */
  blockedHostNames?: string[];
}

export interface EgressBlockedEvent {
  host: string;
  port: number;
  reason: EgressBlockReason;
}

export interface EgressGuard {
  /** SOCKS5 on 127.0.0.1. */
  port: number;
  pid: number;
  /** Settles with the exit code once the process is gone, whoever ended it. */
  exited: Promise<number | null>;
  update(opts: EgressOptions): void;
  onBlocked(cb: (e: EgressBlockedEvent) => void): () => void;
  onCanary(cb: () => void): () => void;
  stop(): Promise<void>;
}

/** How to start the child: the binary itself when compiled, the module under Bun from source. */
export function egressWorkerCmd(): string[] {
  return isCompiledBinary()
    ? [process.execPath, "__web_egress__"]
    : [process.execPath, "run", resolve(import.meta.dir, "egress-main.ts"), "__web_egress__"];
}

function configLine(opts: EgressOptions): string {
  return `${JSON.stringify({
    type: "config",
    allowLocalhost: opts.allowLocalhost,
    allowLan: opts.allowLan,
    blockedLocalPorts: [...new Set(opts.blockedLocalPorts)],
    blockedHostNames: [...new Set(opts.blockedHostNames ?? [])],
  })}\n`;
}

function subscribe<T>(set: Set<T>, cb: T): () => void {
  set.add(cb);
  return () => set.delete(cb);
}

export async function startEgressGuard(opts: EgressOptions): Promise<EgressGuard> {
  const proc: Subprocess<"pipe", "pipe", "inherit"> = Bun.spawn({
    cmd: egressWorkerCmd(),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
    windowsHide: true,
  });
  const blocked = new Set<(e: EgressBlockedEvent) => void>();
  const canary = new Set<() => void>();
  let onReady: (port: number) => void = () => {};
  const ready = new Promise<number>((ok) => { onReady = ok; });

  // One write then one flush per message: a FileSink write takes the whole line.
  let writes: Promise<void> = Promise.resolve();
  const send = (line: string) => {
    writes = writes.then(async () => {
      try {
        proc.stdin.write(line);
        await proc.stdin.flush();
      } catch {}
    });
  };

  const handleLine = (line: string) => {
    let m: Record<string, unknown>;
    try { m = JSON.parse(line); } catch { return; }
    if (m.type === "ready" && Number.isInteger(m.port)) onReady(m.port as number);
    else if (m.type === "canary") for (const cb of canary) try { cb(); } catch {}
    else if (m.type === "blocked" && typeof m.host === "string" && REASONS.includes(m.reason as EgressBlockReason)) {
      const event = { host: m.host, port: Number(m.port), reason: m.reason as EgressBlockReason };
      // A page retrying a refused address in a loop must not flood ppm.log or the viewers:
      // one report per host:port every few seconds.
      const key = `${event.host}:${event.port}`;
      const now = Date.now();
      if (now - (lastReported.get(key) ?? 0) < BLOCK_REPORT_EVERY_MS) return;
      lastReported.set(key, now);
      if (lastReported.size > 512) lastReported.clear();
      log.info(`Browser blocked from ${event.host}:${event.port} (${event.reason})`);
      for (const cb of blocked) try { cb(event); } catch {}
    }
  };

  void (async () => {
    const decoder = new TextDecoder();
    let pending = "";
    const reader = proc.stdout.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = pending.indexOf("\n")) >= 0) {
          handleLine(pending.slice(0, nl));
          pending = pending.slice(nl + 1);
        }
        if (pending.length > 65_536) pending = "";
      }
    } catch {}
  })();

  const exited = proc.exited.then((code) => code, () => null);
  const stop = async () => {
    if (proc.exitCode !== null || proc.signalCode !== null) return void (await exited);
    try { const r = proc.stdin.end(); if (r instanceof Promise) r.catch(() => {}); } catch {}
    try { proc.kill("SIGTERM"); } catch {}
    const gone = await Promise.race([exited.then(() => true), Bun.sleep(STOP_GRACE_MS).then(() => false)]);
    if (!gone) {
      try { proc.kill("SIGKILL"); } catch {}
      await exited;
    }
  };

  send(configLine(opts));
  const port = await Promise.race([
    ready,
    exited.then((code) => { throw new Error(`egress proxy exited before it was ready (code ${code})`); }),
    Bun.sleep(READY_TIMEOUT_MS).then(() => { throw new Error(`egress proxy not ready within ${READY_TIMEOUT_MS} ms`); }),
  ]).catch(async (error: unknown) => {
    await stop();
    throw error;
  });
  log.info(`Browser egress proxy on 127.0.0.1:${port} (PID ${proc.pid})`);

  return {
    port,
    pid: proc.pid,
    exited,
    update: (next) => send(configLine(next)),
    onBlocked: (cb) => subscribe(blocked, cb),
    onCanary: (cb) => subscribe(canary, cb),
    stop,
  };
}
