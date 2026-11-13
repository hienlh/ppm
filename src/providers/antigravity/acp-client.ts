import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { createLogger } from "../../services/logger.ts";

const log = createLogger("antigravity");

/**
 * Bound for the control calls (initialize, session/new, set_model). They answer within two
 * seconds on a healthy agy; past this it is a process that will never answer. A prompt runs
 * for as long as the turn does and is never given a bound.
 */
export const ACP_CONTROL_TIMEOUT_MS = 30_000;

/** How long agy gets to exit on its own once its stdin is closed, before SIGTERM, then SIGKILL. */
const EXIT_GRACE_MS = 1_000;
const KILL_GRACE_MS = 3_000;

export interface AcpNotification {
  method: string;
  params: unknown;
}

/** A request agy sends to PPM, such as `session/request_permission`. Its ids are agy's own. */
export interface AcpServerRequest {
  id: number | string;
  method: string;
  params: unknown;
}

export class AcpRpcError extends Error {
  constructor(message: string, readonly code?: number) {
    super(message);
  }
}

/**
 * JSON-RPC 2.0 over the stdio of `agy acp` (Agent Client Protocol), one message per line.
 * Requests go both ways: agy asks PPM for permission with a request of its own.
 */
export class AcpClient {
  private proc: ChildProcess | null = null;
  private buf = "";
  private decoder = new StringDecoder("utf8");
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private exited = false;
  private onNotificationFn: (n: AcpNotification) => void = () => {};
  private onRequestFn: (r: AcpServerRequest) => void = () => {};
  private onCloseFn: (code: number | null) => void = () => {};
  /** agy's last stderr line, for the message shown when it exits on its own. */
  lastStderr = "";

  start(command: string[], opts: { cwd: string; env: Record<string, string> }): void {
    const [file, ...args] = command;
    try {
      this.proc = spawn(file!, args, { cwd: opts.cwd, env: opts.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    } catch (e) {
      this.lastStderr = (e as Error).message;
      queueMicrotask(() => this.handleClose(null));
      return;
    }
    this.proc.stdout!.on("data", (chunk: Buffer) => this.onStdout(chunk));
    this.proc.stderr!.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n")) {
        const s = line.trim();
        if (!s) continue;
        this.lastStderr = s.slice(0, 200);
        log.debug(`agy stderr: ${this.lastStderr}`);
      }
    });
    // A write after agy is gone fails with EPIPE; the close handler reports the exit itself.
    this.proc.stdin!.on("error", () => {});
    this.proc.on("error", (err) => {
      this.lastStderr ||= err.message;
      this.handleClose(null);
    });
    this.proc.on("close", (code) => this.handleClose(code));
  }

  get pid(): number | undefined {
    return this.proc?.pid;
  }

  get isClosed(): boolean {
    return this.exited;
  }

  onNotification(fn: (n: AcpNotification) => void): void { this.onNotificationFn = fn; }
  onServerRequest(fn: (r: AcpServerRequest) => void): void { this.onRequestFn = fn; }
  onClose(fn: (code: number | null) => void): void { this.onCloseFn = fn; }

  request<T = unknown>(method: string, params: unknown, timeoutMs?: number): Promise<T> {
    if (this.exited) return Promise.reject(new AcpRpcError("agy is not running"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      if (timeoutMs != null) {
        timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new AcpRpcError(`${method} got no answer within ${Math.round(timeoutMs / 1000)}s`));
        }, timeoutMs);
      }
      this.pending.set(id, {
        resolve: (v) => { if (timer) clearTimeout(timer); resolve(v as T); },
        reject: (e) => { if (timer) clearTimeout(timer); reject(e); },
      });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  respond(id: number | string, result: unknown): void {
    this.write({ jsonrpc: "2.0", id, result });
  }

  respondError(id: number | string, code: number, message: string): void {
    this.write({ jsonrpc: "2.0", id, error: { code, message } });
  }

  /** Close stdin, which ends agy, and force it only if it is still there after a grace period. */
  close(): void {
    const proc = this.proc;
    if (!proc || this.exited) return;
    try { proc.stdin?.end(); } catch { /* already closed */ }
    const term = setTimeout(() => { if (!this.exited) proc.kill("SIGTERM"); }, EXIT_GRACE_MS);
    const kill = setTimeout(() => { if (!this.exited) proc.kill("SIGKILL"); }, EXIT_GRACE_MS + KILL_GRACE_MS);
    term.unref?.();
    kill.unref?.();
    proc.once("close", () => { clearTimeout(term); clearTimeout(kill); });
  }

  private write(msg: unknown): void {
    if (this.exited) return;
    try {
      this.proc?.stdin?.write(`${JSON.stringify(msg)}\n`);
    } catch { /* gone; the close handler reports it */ }
  }

  private onStdout(chunk: Buffer): void {
    // A pipe chunk can end inside a multi-byte character of a text delta.
    this.buf += this.decoder.write(chunk);
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) !== -1) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(line); } catch { continue; }
      this.dispatch(msg);
    }
  }

  private dispatch(msg: Record<string, unknown>): void {
    const id = msg.id;
    const hasId = typeof id === "number" || typeof id === "string";
    const method = typeof msg.method === "string" ? msg.method : null;
    if (hasId && !method) {
      const entry = typeof id === "number" ? this.pending.get(id) : undefined;
      if (!entry) return;
      this.pending.delete(id as number);
      const err = msg.error as { code?: number; message?: string } | undefined;
      if (err) entry.reject(new AcpRpcError(err.message || "agy returned an error", err.code));
      else entry.resolve(msg.result);
      return;
    }
    if (hasId && method) {
      this.onRequestFn({ id: id as number | string, method, params: msg.params });
      return;
    }
    if (method) this.onNotificationFn({ method, params: msg.params });
  }

  private handleClose(code: number | null): void {
    if (this.exited) return;
    this.exited = true;
    for (const entry of this.pending.values()) entry.reject(new AcpRpcError("agy exited"));
    this.pending.clear();
    this.onCloseFn(code);
  }
}
