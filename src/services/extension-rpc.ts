import type { RpcRequest, RpcResponse, RpcEvent, RpcMessage } from "../types/extension.ts";

const RPC_TIMEOUT = 10_000; // 10s per request

type RpcHandler = (params: unknown[]) => unknown | Promise<unknown>;

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

  constructor(postFn: (msg: RpcMessage) => void) {
    this.postFn = postFn;
  }

  /** Send a request and wait for response (with timeout) */
  sendRequest<T = unknown>(method: string, ...params: unknown[]): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC timeout: ${method} (${RPC_TIMEOUT}ms)`));
      }, RPC_TIMEOUT);

      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });

      this.postFn({ type: "request", id, method, params });
    });
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
      } else {
        try {
          response.result = await handler(msg.params);
        } catch (e) {
          response.error = e instanceof Error ? e.message : String(e);
        }
      }
      this.postFn(response);
      return;
    }

    if (msg.type === "event") {
      const handlers = this.eventHandlers.get(msg.event);
      if (handlers) {
        for (const h of handlers) {
          try { h(msg.data); } catch (e) { console.error(`[RPC] Event handler error (${msg.event}):`, e); }
        }
      }
    }
  }

  /** Clean up all pending requests */
  dispose(): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("RPC channel disposed"));
    }
    this.pending.clear();
    this.handlers.clear();
    this.eventHandlers.clear();
  }
}
