import { spawn, type ChildProcess } from "node:child_process";
import { basename } from "node:path";
import { resolveBunPath } from "../../services/autostart-generator.ts";
import { redactTruncate } from "./codex-redact.ts";
import type { JsonRpcResponse, ServerRequest, JsonRpcNotification } from "./codex-protocol.ts";
import { AI_CHAT_MARK } from "../../services/ai-chat-env.ts";
import { createLogger } from "../../services/logger.ts";

const log = createLogger("codex");

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

/**
 * Bound for short control calls — handshake, model list, skill list, quota read.
 * These answer in about a second when the app-server is healthy; anything past
 * this is a subprocess that will never answer, not a slow one. A turn is NOT a
 * control call and must never be given this bound.
 */
export const CONTROL_REQUEST_TIMEOUT_MS = 15_000;

/**
 * The allowlisted part of PPM's environment, plus AI_CHAT_MARK: `ppm db` run by the model then
 * keeps to the connections available to the AI chat.
 */
function buildSpawnEnv(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v == null) continue;
    if (ENV_ALLOWLIST.includes(k) || ENV_PREFIX_ALLOWLIST.some((p) => k.startsWith(p))) {
      out[k] = v;
    }
  }
  return { ...out, ...AI_CHAT_MARK };
}

/**
 * The argv that runs the scoped `@openai/codex` package through bun's resolver.
 *
 * Not `process.execPath`: that is bun only when PPM runs from source. A compiled PPM is
 * its own executable, so `<ppm> x @openai/codex app-server` reached PPM's CLI, which
 * rejects `x` — every spawn ended as "codex subprocess exited". The availability probe
 * hid it, because `<ppm> x @openai/codex --version` is answered by PPM's own `--version`
 * with exit 0, so the provider registered as installed on exactly those hosts.
 */
export function codexCommand(...args: string[]): string[] {
  return [resolveBunPath(), "x", "@openai/codex", ...args];
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
  /** Set by close(): an exit after it was asked for, not a crash. */
  private closing = false;
  /** What the app-server is for — decides how loudly its start and exit are logged. */
  private purpose: "chat" | "login" | "control" = "control";
  /** The last stderr line logged, for the exit line (redacted). */
  private lastStderr = "";

  /** Spawn the subprocess. Injectable streams allow unit testing without a real spawn.
   * `codexHome` selects which account's auth the app-server uses (CODEX_HOME); `env` adds
   * variables this one session needs (a design session's MCP token). `purpose` only sets
   * the log level of its start and exit: a chat or a login is lifecycle at INFO, while
   * the short-lived control spawns (usage sweep, model and skill lists, fork) are DEBUG. */
  start(opts?: { cwd?: string; codexHome?: string; env?: Record<string, string>; purpose?: "chat" | "login" | "control" }): void {
    const env = { ...buildSpawnEnv(), ...(opts?.env ?? {}) };
    if (opts?.codexHome) env.CODEX_HOME = opts.codexHome;
    const [cmd, ...args] = codexCommand("app-server");
    this.proc = spawn(cmd!, args, {
      cwd: opts?.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env,
      windowsHide: true,
    });
    this.purpose = opts?.purpose ?? "control";
    // CODEX_HOME is <ppm dir>/codex-accounts/<account id>, so its name is the account id.
    this.lifecycleLog(
      `app-server started pid=${this.proc.pid ?? "?"}${opts?.cwd ? ` cwd=${opts.cwd}` : ""} ` +
      `account=${opts?.codexHome ? basename(opts.codexHome) : "ambient"} purpose=${this.purpose}`,
    );
    this.attach(this.proc.stdout!, this.proc.stderr);
    this.proc.on("close", (code, signal) => this.handleClose(code, signal));
    this.proc.on("error", (err) => {
      log.error(`app-server pid=${this.proc?.pid ?? "?"} subprocess error: ${redactTruncate(err.message, 200)} pending=${this.pending.size}`);
      this.handleClose(null, null, true);
    });
  }

  private lifecycleLog(message: string): void {
    (this.purpose === "control" ? log.debug : log.info)(message);
  }

  /** Wire stream parsing — separated so tests can drive it with fake streams. */
  attach(stdout: NodeJS.ReadableStream, stderr?: NodeJS.ReadableStream | null): void {
    stdout.on("data", (chunk: Buffer) => this.onStdout(chunk));
    stderr?.on("data", (chunk: Buffer) => {
      // codex's stderr is Rust tracing ("<time> ERROR codex_x::y: …", ANSI-coloured), so its
      // own level decides ours: a failed cache write is not a PPM ERROR. An untagged line is
      // `bun x` resolving the package unless it reads like a failure.
      for (const line of chunk.toString().replace(/\x1b\[[0-9;]*m/g, "").split("\n")) {
        const s = line.trim();
        if (!s || /warning|trace-warnings|circular dependency/i.test(s)) continue;
        const tag = /^(?:\S+\s+)?(ERROR|WARN|INFO|DEBUG|TRACE)\b/.exec(s)?.[1];
        const loud = tag ? tag === "ERROR" || tag === "WARN" : /error|panic|fatal|fail/i.test(s);
        this.lastStderr = redactTruncate(s, 200);
        (loud ? log.warn : log.debug)(`stderr: ${this.lastStderr}`);
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

  /**
   * Send a request and wait for its reply.
   *
   * `timeoutMs` bounds the wait. It is opt-in because a turn legitimately runs
   * for many minutes, but every short control call should pass one: the
   * app-server has been observed to accept a spawn and then never answer even
   * `initialize`. Without a bound, the promise never settles, so the caller's
   * `finally` never runs, the subprocess is never closed, and any HTTP route
   * waiting on it hangs until the client gives up — one orphaned app-server per
   * attempt, and a blank reading at the other end.
   *
   * A timeout rejects and drops the pending entry, so a late reply is ignored
   * rather than resolving a promise the caller already abandoned.
   */
  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    if (this.closed) return Promise.reject(new Error("codex client closed"));
    const id = this.nextId++;
    const line = JSON.stringify({ id, method, params }) + "\n";
    return new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = <A extends unknown[]>(fn: (...args: A) => void) => (...args: A) => {
        if (timer) clearTimeout(timer);
        fn(...args);
      };
      const wrapped = {
        resolve: settle(resolve as (v: unknown) => void),
        reject: settle(reject),
      };
      if (timeoutMs != null) {
        timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`codex ${method} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }
      this.pending.set(id, wrapped);
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
        log.error(`write failed: ${redactTruncate((e as Error)?.message, 120)}`);
      }
    }
  }

  /** `logged`: the caller already wrote the line that explains this close. */
  private handleClose(code: number | null, signal: NodeJS.Signals | null = null, logged = false): void {
    if (this.closed) return;
    this.closed = true;
    if (!logged) {
      const pid = this.proc?.pid ?? "?";
      if (this.closing) this.lifecycleLog(`app-server pid=${pid} exited code=${code} signal=${signal}`);
      else {
        log.error(
          `app-server pid=${pid} exited unexpectedly code=${code} signal=${signal} pending=${this.pending.size}` +
          (this.lastStderr ? ` — last stderr: ${this.lastStderr}` : ""),
        );
      }
    }
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
    this.closing = true;
    try { this.proc?.stdin?.end(); } catch { /* ignore */ }
    try { this.proc?.kill("SIGTERM"); } catch { /* ignore */ }
  }

  /** Expose underlying process for tree-kill (windows grandchild reaping). */
  get process(): ChildProcess | null { return this.proc; }
}

export { buildSpawnEnv };
