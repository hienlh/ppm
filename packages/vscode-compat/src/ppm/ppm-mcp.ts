import type { RpcClient } from "../types.ts";

/**
 * `api.ppm.mcp` — tools an extension serves to the chats it bound. A chat whose binding names a
 * toolset (`ppm.chat.bind(sessionId, { toolsets: [id] })`) sees each tool as
 * `mcp__ppm-ext__<toolset>_<name>`; PPM forwards the model's call to `handler` and hands its text
 * back. The main thread checks every registration (`src/shared/extension-mcp.ts`):
 * - `id`: 2-16 lowercase letters or digits; `title`: 1-200 characters.
 * - 1-40 tools; `name`: 2-41 lowercase letters, digits or `_`, starting with a letter, and
 *   `<id>_<name>` at most 50 characters (Claude refuses longer tool names).
 * - `description`: 1-2,000 characters; `inputSchema`: a JSON schema of type `"object"`, ≤ 16 KB.
 *
 * A call may run for at most 10 minutes; longer work should start in one tool and be polled
 * through another. An answer over 200 KB is cut. `ctx.signal` aborts when the model gives up on
 * the call (the user stopped the turn), the call outlives its time limit, or the extension host
 * restarts.
 *
 * `registerToolset` sends the main thread's registration RPC and, once accepted, holds the handle
 * it returned so a later `dispose()` can name it — nothing else in this worker ever sees that
 * value. Once the extension host's own `host.dispose()` has run (deactivated, or its activation
 * failed or timed out), `registerToolset` refuses every further call on the spot: the extension's
 * `activate()` can keep running after a timeout, and whatever it registers after that must never
 * reach a chat, because nothing on this host would route to it any more.
 */

export interface PpmMcpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface PpmMcpToolset {
  id: string;
  title: string;
  tools: PpmMcpToolDefinition[];
}

export interface PpmMcpCallContext {
  sessionId: string;
  /** `"ws"`: a person typed the message behind this call; `"extension"`: an extension started the turn. */
  turnOrigin: string;
  signal: AbortSignal;
}

export interface PpmMcpToolResult {
  text: string;
  isError?: boolean;
}

/** `name` is the tool's own name, without the toolset prefix. */
export type PpmMcpToolHandler = (name: string, args: Record<string, unknown>, ctx: PpmMcpCallContext) => Promise<PpmMcpToolResult>;

export interface PpmMcpRegistration {
  dispose(): void;
  /** The exposed tool names once PPM accepted the toolset; rejects with why it did not. */
  readonly registered: Promise<string[]>;
}

export interface PpmMcp {
  registerToolset(toolset: PpmMcpToolset, handler: PpmMcpToolHandler): PpmMcpRegistration;
}

/** What the extension host routes `ext:mcp:call` through; not handed to the extension. */
export interface PpmMcpHost {
  call(request: unknown): Promise<PpmMcpToolResult>;
  cancel(callId: unknown): boolean;
  dispose(): void;
}

function abortError(): Error {
  const error = new Error("The call was cancelled");
  error.name = "AbortError";
  return error;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export function createPpmMcp(rpc: RpcClient, extensionId: string): { api: PpmMcp; host: PpmMcpHost } {
  const handlers = new Map<string, PpmMcpToolHandler>();
  const running = new Map<string, AbortController>();
  /** Set once by `host.dispose()`; nothing registered after that can ever be routed to. */
  let closed = false;
  const forget = (id: string, handler: PpmMcpToolHandler) => {
    if (handlers.get(id) === handler) handlers.delete(id);
  };

  const api: PpmMcp = {
    registerToolset(toolset, handler) {
      const id = toolset?.id;
      if (typeof id !== "string" || !id) throw new TypeError("toolset.id must be a string");
      if (typeof handler !== "function") throw new TypeError("handler must be a function");
      if (handlers.has(id)) throw new Error(`Toolset "${id}" is already registered by this extension`);
      if (closed) {
        const message = `Toolset "${id}" was refused: the extension host no longer accepts toolsets`;
        console.error(`[ppm.mcp] toolset "${id}" was refused:`, message);
        const registered: Promise<string[]> = Promise.reject(new Error(message));
        registered.catch(() => {});
        return { registered, dispose() {} };
      }
      handlers.set(id, handler);
      let disposed = false;
      // Known only once the main thread answers; a dispose() that beat it there sends the
      // unregister itself the moment it arrives, so it is read here rather than captured once.
      let handle: string | undefined;
      const registered = rpc.request<{ tools: string[]; handle: string }>("mcp:registerToolset", { extensionId, toolset }).then(
        (answer) => {
          handle = answer.handle;
          if (disposed) rpc.request("mcp:unregisterToolset", { extensionId, toolsetId: id, handle }).catch(() => {});
          return answer.tools;
        },
        (error: unknown) => {
          forget(id, handler);
          console.error(`[ppm.mcp] toolset "${id}" was refused:`, error instanceof Error ? error.message : error);
          throw error;
        },
      );
      // Already logged; an extension that never awaits it must not leave an unhandled rejection.
      registered.catch(() => {});
      return {
        registered,
        dispose() {
          if (disposed) return;
          disposed = true;
          forget(id, handler);
          // Else: still unanswered, or refused (nothing was ever registered); the `.then` above
          // sends it once the handle arrives, and the rejection branch already forgot the handler.
          if (handle !== undefined) rpc.request("mcp:unregisterToolset", { extensionId, toolsetId: id, handle }).catch(() => {});
        },
      };
    },
  };

  const host: PpmMcpHost = {
    async call(request) {
      const r = isObject(request) ? request : {};
      const toolsetId = typeof r.toolsetId === "string" ? r.toolsetId : "";
      const handler = handlers.get(toolsetId);
      if (!handler) return { text: `The extension has no toolset "${toolsetId.slice(0, 40)}" running.`, isError: true };
      const callId = typeof r.callId === "string" ? r.callId : crypto.randomUUID();
      const controller = new AbortController();
      running.set(callId, controller);
      const ctx = isObject(r.ctx) ? r.ctx : {};
      try {
        const result = await handler(String(r.name ?? ""), isObject(r.args) ? r.args : {}, {
          sessionId: typeof ctx.sessionId === "string" ? ctx.sessionId : "",
          turnOrigin: typeof ctx.turnOrigin === "string" ? ctx.turnOrigin : "unknown",
          signal: controller.signal,
        });
        if (!isObject(result) || typeof result.text !== "string") return { text: "The tool returned no text.", isError: true };
        return result.isError === true ? { text: result.text, isError: true } : { text: result.text };
      } catch (error) {
        return { text: `The tool failed: ${error instanceof Error ? error.message : String(error)}`, isError: true };
      } finally {
        running.delete(callId);
      }
    },
    cancel(callId) {
      const controller = typeof callId === "string" ? running.get(callId) : undefined;
      if (!controller) return false;
      // Freed here rather than left to `call`'s own `finally`: a handler that never notices the
      // abort would otherwise hold its bookkeeping forever, and a second cancel of the same id
      // would wrongly report there was still something to cancel.
      running.delete(callId as string);
      controller.abort(abortError());
      return true;
    },
    dispose() {
      closed = true;
      for (const controller of running.values()) controller.abort(abortError());
      running.clear();
      handlers.clear();
    },
  };

  return { api, host };
}
