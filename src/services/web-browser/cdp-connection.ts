/**
 * One Chrome DevTools Protocol connection in flattened-session mode: every command and event
 * carries an optional `sessionId` naming the attached target it belongs to.
 *
 * The bytes travel over one of two transports (`cdp-transports.ts`): Chrome's own pipe
 * (`--remote-debugging-pipe`, no port at all) where the runtime can hand Chrome fd 3/4, else a
 * WebSocket to a DevTools port bound to 127.0.0.1. Bun 1.3.12 on Windows — the runtime releases
 * are built with — cannot pass extra pipes to a child (measured: EBADF through both `Bun.spawn`
 * and `node:child_process`), so Windows uses the port.
 */
import { createLogger } from "../logger.ts";

const log = createLogger("web-browser");

/** Commands that never answer would otherwise hold their promise for good. */
const COMMAND_TIMEOUT_MS = 30_000;

export interface CdpTransport {
  /** Sends one JSON message. */
  send(message: string): void;
  /** Called with every JSON message Chrome writes. */
  onMessage(cb: (message: string) => void): void;
  /** Called once when the transport is gone (Chrome exited, socket closed). */
  onClose(cb: () => void): void;
  close(): void;
}

export interface CdpEvent {
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

export class CdpError extends Error {
  constructor(readonly method: string, readonly code: number, message: string) {
    super(`${method}: ${message}`);
  }
}

type Pending = { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout>; method: string };

export class CdpConnection {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<(e: CdpEvent) => void>();
  private readonly closeListeners = new Set<() => void>();
  private closed = false;

  constructor(private readonly transport: CdpTransport) {
    transport.onMessage((raw) => this.receive(raw));
    transport.onClose(() => this.markClosed());
  }

  get isClosed(): boolean {
    return this.closed;
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    if (this.closed) return Promise.reject(new CdpError(method, -1, "connection closed"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpError(method, -2, "timed out"));
      }, COMMAND_TIMEOUT_MS);
      this.pending.set(id, { resolve: resolve as Pending["resolve"], reject, timer, method });
      try {
        this.transport.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new CdpError(method, -1, String((error as Error)?.message ?? error)));
      }
    });
  }

  /** Every event, all sessions. Returns the unsubscribe. */
  onEvent(cb: (e: CdpEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  onClose(cb: () => void): () => void {
    if (this.closed) queueMicrotask(cb);
    else this.closeListeners.add(cb);
    return () => this.closeListeners.delete(cb);
  }

  close(): void {
    if (this.closed) return;
    try { this.transport.close(); } catch {}
    this.markClosed();
  }

  private receive(raw: string): void {
    let msg: { id?: number; result?: Record<string, unknown>; error?: { code: number; message: string }; method?: string; params?: Record<string, unknown>; sessionId?: string };
    try { msg = JSON.parse(raw); } catch { return; }
    if (typeof msg.id === "number") {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new CdpError(p.method, msg.error.code, msg.error.message));
      else p.resolve(msg.result ?? {});
      return;
    }
    if (typeof msg.method !== "string") return;
    const event: CdpEvent = { method: msg.method, params: msg.params ?? {}, ...(msg.sessionId ? { sessionId: msg.sessionId } : {}) };
    for (const cb of this.listeners) {
      try { cb(event); } catch (error) { log.warn(`CDP listener for ${event.method} failed: ${(error as Error)?.message ?? error}`); }
    }
  }

  private markClosed(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new CdpError(p.method, -1, "connection closed"));
    }
    this.pending.clear();
    for (const cb of this.closeListeners) {
      try { cb(); } catch {}
    }
    this.closeListeners.clear();
  }
}
