import { spawn, type ChildProcess } from "node:child_process";
import { redactTruncate } from "./codex-redact.ts";
import type { JsonRpcResponse, ServerRequest, JsonRpcNotification } from "./codex-protocol.ts";

export type NotificationHandler = (notif: JsonRpcNotification) => void;
export type ServerRequestHandler = (req: ServerRequest) => void;
export type CloseHandler = (code: number | null) => void;

/** Environment variables the codex subprocess is allowed to inherit. */
const ENV_ALLOWLIST = [
  "PATH", "Path", "PATHEXT",
  "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH",
  "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "ProgramFiles", "ProgramFiles(x86)",
  "TEMP", "TMP", "TMPDIR",
  "SystemRoot", "SystemDrive", "windir", "ComSpec",
  "LANG", "LC_ALL", "TZ", "TERM",
  "SHELL", "USER", "LOGNAME",
];
/** Prefixes kept (codex/XDG own their auth + config). */
const ENV_PREFIX_ALLOWLIST = ["CODEX_", "XDG_", "RUST_"];

function buildSpawnEnv(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v == null) continue;
    if (ENV_ALLOWLIST.includes(k) || ENV_PREFIX_ALLOWLIST.some((p) => k.startsWith(p))) {
      out[k] = v;
    }
  }
  return out;
}

function validId(id: unknown): id is number | string {
  return typeof id === "number" || typeof id === "string";
}

/**
 * Newline-delimited JSON-RPC client over `codex app-server` stdio.
 * Spawns the SCOPED `@openai/codex` binary (via bun's resolver) — never a PATH
 * `codex` (unproven + risks the squat prank package).
 */
export class CodexJsonRpcClient {
  private proc: ChildProcess | null = null;
  private buf = "";
  private nextId = 1;
  private pending = new Map<number | string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private notifHandler: NotificationHandler = () => {};
  private serverReqHandler: ServerRequestHandler = () => {};
  private closeHandler: CloseHandler = () => {};
  private closed = false;

  /** Spawn the subprocess. Injectable streams allow unit testing without a real spawn. */
  start(opts?: { cwd?: string }): void {
    this.proc = spawn(process.execPath, ["x", "@openai/codex", "app-server"], {
      cwd: opts?.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: buildSpawnEnv(),
      windowsHide: true,
    });
    this.attach(this.proc.stdout!, this.proc.stderr);
    this.proc.on("close", (code) => this.handleClose(code));
    this.proc.on("error", (err) => {
      console.error(`[codex] subprocess error: ${redactTruncate(err.message, 200)}`);
      this.handleClose(null);
    });
  }

  /** Wire stream parsing — separated so tests can drive it with fake streams. */
  attach(stdout: NodeJS.ReadableStream, stderr?: NodeJS.ReadableStream | null): void {
    stdout.on("data", (chunk: Buffer) => this.onStdout(chunk));
    stderr?.on("data", (chunk: Buffer) => {
      const s = chunk.toString().trim();
      if (s && !/warning|trace-warnings|circular dependency/i.test(s)) {
        console.error(`[codex] stderr: ${redactTruncate(s, 200)}`);
      }
    });
  }

  private onStdout(chunk: Buffer): void {
    this.buf += chunk.toString();
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) !== -1) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(line); } catch { continue; } // skip malformed
      this.dispatch(msg);
    }
  }

  private dispatch(msg: Record<string, unknown>): void {
    const hasId = "id" in msg && validId(msg.id);
    const hasMethod = typeof msg.method === "string";

    // Response: id + (result|error), no method.
    if (hasId && !hasMethod && ("result" in msg || "error" in msg)) {
      const id = msg.id as number | string;
      const entry = this.pending.get(id);
      if (!entry) return; // id-safety: drop non-pending result (ignore-once)
      this.pending.delete(id);
      const r = msg as unknown as JsonRpcResponse;
      if (r.error) entry.reject(new Error(r.error.message || "codex JSON-RPC error"));
      else entry.resolve(r.result);
      return;
    }

    // Server→client request: id + method. Disjoint id space — never touches pending.
    if (hasId && hasMethod) {
      this.serverReqHandler({ id: msg.id as number | string, method: msg.method as string, params: msg.params });
      return;
    }

    // Notification: method, no id.
    if (hasMethod) {
      this.notifHandler({ method: msg.method as string, params: msg.params });
    }
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new Error("codex client closed"));
    const id = this.nextId++;
    const line = JSON.stringify({ id, method, params }) + "\n";
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.write(line);
    });
  }

  notify(method: string, params?: unknown): void {
    this.write(JSON.stringify({ method, params }) + "\n");
  }

  /** Respond to a server request. EPIPE-safe (swallows write-after-close). */
  respond(id: number | string, result: unknown): void {
    this.write(JSON.stringify({ id, result }) + "\n");
  }

  respondError(id: number | string, message: string): void {
    this.write(JSON.stringify({ id, error: { code: -32000, message } }) + "\n");
  }

  private write(line: string): void {
    try {
      this.proc?.stdin?.write(line);
    } catch (e) {
      // stdin closed / EPIPE — subprocess is gone; ignore.
      if ((e as NodeJS.ErrnoException)?.code !== "EPIPE") {
        console.error(`[codex] write failed: ${redactTruncate((e as Error)?.message, 120)}`);
      }
    }
  }

  private handleClose(code: number | null): void {
    if (this.closed) return;
    this.closed = true;
    for (const [, entry] of this.pending) {
      entry.reject(new Error("codex subprocess exited"));
    }
    this.pending.clear();
    this.closeHandler(code);
  }

  onNotification(fn: NotificationHandler): void { this.notifHandler = fn; }
  onServerRequest(fn: ServerRequestHandler): void { this.serverReqHandler = fn; }
  onClose(fn: CloseHandler): void { this.closeHandler = fn; }

  get pid(): number | undefined { return this.proc?.pid; }
  get isClosed(): boolean { return this.closed; }

  close(): void {
    try { this.proc?.stdin?.end(); } catch { /* ignore */ }
    try { this.proc?.kill("SIGTERM"); } catch { /* ignore */ }
  }

  /** Expose underlying process for tree-kill (windows grandchild reaping). */
  get process(): ChildProcess | null { return this.proc; }
}

export { buildSpawnEnv };
