/**
 * One language server child process, from spawn to exit.
 *
 * A session is dumb about editors and about projects — it speaks JSON-RPC to
 * one server rooted at one directory. `lsp-manager.ts` decides how many of
 * these exist and who shares them.
 *
 * Three things here are less obvious than they look:
 *
 * - **Server-to-client requests must be answered.** A server that asks
 *   `workspace/configuration` or `client/registerCapability` and never hears
 *   back does not degrade, it stalls: tsserver waits for its configuration
 *   before it will answer a single completion. So unknown requests get an
 *   explicit MethodNotFound rather than silence.
 * - **Every request needs a timeout.** A provider in Monaco awaits a promise;
 *   one that never settles leaves the suggest widget spinning forever with no
 *   way back. Rejecting is recoverable, hanging is not.
 * - **The process must not outlive the session.** A leaked rust-analyzer keeps
 *   a crate graph in memory indefinitely, and PPM runs on machines where that
 *   is the whole machine.
 */
import { CLIENT_CAPABILITIES } from "./lsp-capabilities.ts";
import { LspMessageDecoder, encodeMessage, type JsonRpcMessage } from "./lsp-protocol.ts";
import type { LanguageServerDefinition } from "./server-registry.ts";
import { pathToFileUri } from "../../shared/lsp-uri.ts";

export type LspSessionState = "starting" | "ready" | "stopped" | "crashed";

/** How long a normal request may take before it is treated as lost. */
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
/** `initialize` is allowed longer: a cold server reads a whole dependency tree. */
const INITIALIZE_TIMEOUT_MS = 90_000;
/** Grace given to a `shutdown`/`exit` handshake before the process is killed. */
const SHUTDOWN_GRACE_MS = 3_000;
/** Bound on retained stderr, so a chatty server cannot grow without limit. */
const STDERR_TAIL_BYTES = 8 * 1024;

export interface LspSessionOptions {
  definition: LanguageServerDefinition;
  /** Resolved command — an absolute path, or the bare command for PATH lookup. */
  commandPath: string;
  /** Directory the server is rooted at; becomes its rootUri. */
  rootPath: string;
  /** Server-initiated notifications (diagnostics, progress, logs). */
  onNotification?: (method: string, params: unknown) => void;
  /** Server-initiated requests this session does not answer itself. */
  onServerRequest?: (method: string, params: unknown) => Promise<unknown>;
  /** Called once when the process is gone, for whatever reason. */
  onExit?: (info: { code: number | null; state: LspSessionState; stderr: string }) => void;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  method: string;
}

export class LspSession {
  readonly definition: LanguageServerDefinition;
  readonly rootPath: string;
  state: LspSessionState = "starting";
  /** The server's answer to `initialize`, which says what it can actually do. */
  initializeResult: Record<string, unknown> | null = null;

  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private readonly decoder = new LspMessageDecoder();
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private stderrTail = "";
  private readonly options: LspSessionOptions;
  private exitReported = false;

  private constructor(options: LspSessionOptions) {
    this.options = options;
    this.definition = options.definition;
    this.rootPath = options.rootPath;
  }

  /** Spawn the server and complete the initialize handshake. */
  static async start(options: LspSessionOptions): Promise<LspSession> {
    const session = new LspSession(options);
    await session.spawn();
    await session.initialize();
    return session;
  }

  private async spawn(): Promise<void> {
    const { definition, commandPath, rootPath } = this.options;
    try {
      this.proc = Bun.spawn([commandPath, ...definition.args], {
        cwd: rootPath,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        // The server inherits the environment so it can find its own toolchain
        // (a Go module cache, a rustup shim, a project-local node).
        env: process.env,
      });
    } catch (e) {
      throw new Error(
        `Could not start ${definition.displayName} (${commandPath}): ${e instanceof Error ? e.message : String(e)}. ` +
        `Install it with: ${definition.installHint}`,
      );
    }

    void this.readStdout();
    void this.readStderr();
    void this.watchExit();
  }

  private async readStdout(): Promise<void> {
    const stream = this.proc?.stdout;
    if (!stream || typeof stream === "number") return;
    const reader = stream.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        for (const message of this.decoder.push(value)) this.dispatch(message);
      }
    } catch (e) {
      // Either the pipe broke or the framing desynchronised. Neither can be
      // recovered from mid-stream: the only honest move is to fail the session
      // so the manager can start a fresh server.
      this.fail(e instanceof Error ? e.message : String(e));
    }
  }

  private async readStderr(): Promise<void> {
    const stream = this.proc?.stderr;
    if (!stream || typeof stream === "number") return;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        this.stderrTail = (this.stderrTail + decoder.decode(value, { stream: true })).slice(-STDERR_TAIL_BYTES);
      }
    } catch {
      // stderr is diagnostics only; losing it must not take the session down.
    }
  }

  private async watchExit(): Promise<void> {
    const code = (await this.proc?.exited) ?? null;
    if (this.state !== "stopped") this.state = "crashed";
    this.rejectAllPending(
      new Error(
        `${this.definition.displayName} exited (code ${code}).` +
        (this.stderrTail.trim() ? ` Last output: ${this.stderrTail.trim().slice(-500)}` : ""),
      ),
    );
    if (!this.exitReported) {
      this.exitReported = true;
      this.options.onExit?.({ code, state: this.state, stderr: this.stderrTail });
    }
  }

  private async initialize(): Promise<void> {
    const result = (await this.request(
      "initialize",
      {
        processId: process.pid,
        clientInfo: { name: "PPM", version: "1" },
        locale: "en",
        rootUri: pathToFileUri(this.rootPath),
        rootPath: this.rootPath,
        capabilities: CLIENT_CAPABILITIES,
        initializationOptions: this.definition.initializationOptions ?? null,
        workspaceFolders: [{ uri: pathToFileUri(this.rootPath), name: this.rootPath.split(/[\\/]/).pop() || "root" }],
      },
      INITIALIZE_TIMEOUT_MS,
    )) as Record<string, unknown> | null;

    this.initializeResult = result ?? {};
    this.notify("initialized", {});
    // Servers that read settings on this notification rather than on request
    // (yaml, css) stay on their defaults without it.
    this.notify("workspace/didChangeConfiguration", { settings: {} });
    this.state = "ready";
  }

  /** What the server said it supports, for the bridge to gate providers on. */
  get serverCapabilities(): Record<string, unknown> {
    return (this.initializeResult?.capabilities as Record<string, unknown>) ?? {};
  }

  request(method: string, params: unknown, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<unknown> {
    if (this.state === "stopped" || this.state === "crashed") {
      return Promise.reject(new Error(`${this.definition.displayName} is not running`));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // Tell the server to stop working on it, so a slow request does not
        // keep costing CPU after nothing is waiting for it.
        this.notify("$/cancelRequest", { id });
        reject(new Error(`${this.definition.displayName} did not answer ${method} within ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this.write({ jsonrpc: "2.0", id, method, params });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  notify(method: string, params: unknown): void {
    if (this.state === "stopped" || this.state === "crashed") return;
    try {
      this.write({ jsonrpc: "2.0", method, params });
    } catch {
      // A broken pipe here means the process is already gone; `watchExit`
      // reports it, and a notification has nobody waiting on it.
    }
  }

  private write(message: JsonRpcMessage): void {
    const stdin = this.proc?.stdin;
    if (!stdin || typeof stdin === "number") throw new Error("Language server stdin is not writable");
    stdin.write(encodeMessage(message));
    stdin.flush();
  }

  private dispatch(message: JsonRpcMessage): void {
    // A response: has an id and no method.
    if (message.id != null && message.method === undefined) {
      const pending = this.pending.get(message.id as number);
      if (!pending) return; // already timed out, or never ours
      clearTimeout(pending.timer);
      this.pending.delete(message.id as number);
      if (message.error) {
        pending.reject(new Error(`${pending.method}: ${message.error.message} (${message.error.code})`));
      } else {
        pending.resolve(message.result ?? null);
      }
      return;
    }

    // A request from the server: needs an answer, whatever the answer is.
    if (message.id != null && message.method) {
      void this.answerServerRequest(message.id, message.method, message.params);
      return;
    }

    // A notification.
    if (message.method) this.options.onNotification?.(message.method, message.params);
  }

  private async answerServerRequest(id: number | string, method: string, params: unknown): Promise<void> {
    try {
      const result = await this.handleServerRequest(method, params);
      this.write({ jsonrpc: "2.0", id, result });
    } catch (e) {
      this.write({
        jsonrpc: "2.0",
        id,
        error: { code: -32603, message: e instanceof Error ? e.message : String(e) },
      });
    }
  }

  private async handleServerRequest(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case "workspace/configuration": {
        // One entry per requested section. Null means "no override", which
        // makes the server use its own defaults — the same thing an editor
        // with no user settings for that server does.
        const items = (params as { items?: unknown[] })?.items ?? [];
        return items.map(() => null);
      }
      // Dynamic (un)registration is accepted rather than honoured: every
      // provider is registered statically from the initialize result, so there
      // is nothing to turn on later. Refusing instead makes some servers retry
      // in a loop.
      case "client/registerCapability":
      case "client/unregisterCapability":
      case "window/workDoneProgress/create":
        return null;

      default: {
        if (this.options.onServerRequest) return this.options.onServerRequest(method, params);
        // Explicit MethodNotFound, never silence: a server waiting on an
        // unanswered request stops serving completions entirely.
        throw Object.assign(new Error(`Unhandled server request: ${method}`), { code: -32601 });
      }
    }
  }

  private fail(reason: string): void {
    if (this.state === "stopped") return;
    this.state = "crashed";
    this.rejectAllPending(new Error(`${this.definition.displayName} session failed: ${reason}`));
    this.proc?.kill();
  }

  private rejectAllPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  /**
   * Kill the process immediately, skipping the shutdown handshake.
   *
   * For the synchronous exit path, where there is nothing to await.
   */
  kill(): void {
    this.state = "stopped";
    this.rejectAllPending(new Error(`${this.definition.displayName} was killed`));
    this.proc?.kill();
  }

  /**
   * Ask the server to stop, then make sure it did.
   *
   * The polite handshake gives a server the chance to flush caches it wants to
   * keep (rust-analyzer and gopls both do), but it is never trusted to finish:
   * a hung server would otherwise stay resident for the life of PPM.
   */
  async dispose(): Promise<void> {
    if (this.state === "stopped") return;
    const wasRunning = this.state === "ready" || this.state === "starting";
    this.state = "stopped";

    if (wasRunning) {
      try {
        await Promise.race([
          this.request("shutdown", null, SHUTDOWN_GRACE_MS).catch(() => undefined),
          Bun.sleep(SHUTDOWN_GRACE_MS),
        ]);
        this.write({ jsonrpc: "2.0", method: "exit", params: undefined });
      } catch {
        // Already gone, or the pipe is closed — the kill below is what counts.
      }
    }

    this.rejectAllPending(new Error(`${this.definition.displayName} was shut down`));

    const proc = this.proc;
    if (!proc) return;
    await Promise.race([proc.exited, Bun.sleep(SHUTDOWN_GRACE_MS)]);
    try {
      proc.kill();
    } catch {
      // Already reaped.
    }
  }
}
