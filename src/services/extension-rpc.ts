import type { RpcRequest, RpcResponse, RpcEvent, RpcMessage } from "../types/extension.ts";

/** Timeout used when a request does not specify its own (see sendRequestWithTimeout). */
const DEFAULT_RPC_TIMEOUT_MS = 10_000;

type RpcHandler = (params: unknown[]) => unknown | Promise<unknown>;

/**
 * The levels this channel logs at; a `Logger` from logger.ts fits. Not imported from there:
 * this module also runs inside the extension host worker, which must not load logger.ts.
 */
export interface RpcLog {
  debug(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

/** The worker's default: its console, which the worker forwards to the main thread's log. */
const consoleRpcLog: RpcLog = {
  debug: (msg, ...rest) => console.debug(`[RPC] ${msg}`, ...rest),
  warn: (msg, ...rest) => console.warn(`[RPC] ${msg}`, ...rest),
  error: (msg, ...rest) => console.error(`[RPC] ${msg}`, ...rest),
};

/**
 * Typed RPC channel over Worker postMessage.
 * Used by both main process (ExtensionService) and worker (ExtensionHost).
 */
export class RpcChannel {
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private handlers = new Map<string, RpcHandler>();
  private eventHandlers = new Map<string, Set<(data: unknown) => void>>();
  private postFn: (msg: RpcMessage) => void;
  private log: RpcLog;
  /** Methods already reported as unhandled: API drift repeats on every call, the warning need not. */
  private warnedUnhandled = new Set<string>();
  /** Set by dispose(): the other side is gone, so nothing more is sent or answered. */
  private disposed = false;

  constructor(postFn: (msg: RpcMessage) => void, log: RpcLog = consoleRpcLog) {
    this.postFn = postFn;
    this.log = log;
  }

  /** Shared body behind sendRequest/sendRequestWithTimeout — id allocation, pending-map
   * bookkeeping and timeout wiring, parameterized on the timeout so callers can opt into a
   * longer wait without duplicating the promise/timer plumbing. */
  private send<T = unknown>(method: string, params: unknown[], timeoutMs: number): Promise<T> {
    if (this.disposed) return Promise.reject(new Error(`RPC channel disposed: ${method}`));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC timeout: ${method} (${timeoutMs}ms)`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });

      this.postFn({ type: "request", id, method, params });
    });
  }

  /** Send a request and wait for response, using the default timeout. */
  sendRequest<T = unknown>(method: string, ...params: unknown[]): Promise<T> {
    return this.send<T>(method, params, DEFAULT_RPC_TIMEOUT_MS);
  }

  /**
   * Send a request with an explicit timeout. Used by interactive verbs (showInputBox,
   * showQuickPick, showComposer) that must stay pending far longer than the default while a
   * dialog waits on user input.
   *
   * Ordering rule: this worker-side timeout must be >= the browser-side timeout the server
   * passes to `requestFromBrowser` for the same round trip — otherwise the worker gives up
   * while the dialog is still open in the browser, and the eventual answer is silently dropped.
   */
  sendRequestWithTimeout<T = unknown>(method: string, timeoutMs: number, params: unknown[]): Promise<T> {
    return this.send<T>(method, params, timeoutMs);
  }

  /** Fire an event (no response expected) */
  sendEvent(event: string, data: unknown): void {
    this.postFn({ type: "event", event, data });
  }

  /** Register a handler for incoming requests */
  onRequest(method: string, handler: RpcHandler): void {
    this.handlers.set(method, handler);
  }

  /** Register a handler for incoming events */
  onEvent(event: string, handler: (data: unknown) => void): void {
    if (!this.eventHandlers.has(event)) this.eventHandlers.set(event, new Set());
    this.eventHandlers.get(event)!.add(handler);
  }

  /** Process an incoming message (call from message event listener) */
  async handleMessage(msg: RpcMessage): Promise<void> {
    if (this.disposed) return;
    if (msg.type === "response") {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      clearTimeout(pending.timer);
      if (msg.error) pending.reject(new Error(msg.error));
      else pending.resolve(msg.result);
      return;
    }

    if (msg.type === "request") {
      const handler = this.handlers.get(msg.method);
      const response: RpcResponse = { type: "response", id: msg.id };
      if (!handler) {
        response.error = `No handler for method: ${msg.method}`;
        // A method the other side calls but this one never registered: vscode-compat and the
        // host have drifted apart, and only the caller would ever hear of it.
        if (this.warnedUnhandled.has(msg.method)) this.log.debug(`no handler for ${msg.method}`);
        else {
          this.warnedUnhandled.add(msg.method);
          this.log.warn(`no handler for ${msg.method}`);
        }
      } else {
        try {
          response.result = await handler(msg.params);
        } catch (e) {
          response.error = e instanceof Error ? e.message : String(e);
          this.log.debug(`${msg.method} failed: ${response.error}`);
        }
      }
      // A handler can outlive the channel: its answer would go to a peer that no longer exists.
      if (this.disposed) {
        this.log.debug(`dropped the answer to ${msg.method}: channel disposed`);
        return;
      }
      this.postFn(response);
      return;
    }

    if (msg.type === "event") {
      const handlers = this.eventHandlers.get(msg.event);
      if (handlers) {
        for (const h of handlers) {
          try { h(msg.data); } catch (e) { this.log.error(`Event handler error (${msg.event}):`, e); }
        }
      }
    }
  }

  /** Clean up all pending requests */
  dispose(): void {
    this.disposed = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("RPC channel disposed"));
    }
    this.pending.clear();
    this.handlers.clear();
    this.eventHandlers.clear();
  }
}
