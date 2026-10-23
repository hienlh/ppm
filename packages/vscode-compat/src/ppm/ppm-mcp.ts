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
 * the call (the user stopped the turn) or the extension host restarts.
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
  const forget = (id: string, handler: PpmMcpToolHandler) => {
    if (handlers.get(id) === handler) handlers.delete(id);
  };

  const api: PpmMcp = {
    registerToolset(toolset, handler) {
      const id = toolset?.id;
      if (typeof id !== "string" || !id) throw new TypeError("toolset.id must be a string");
      if (typeof handler !== "function") throw new TypeError("handler must be a function");
      if (handlers.has(id)) throw new Error(`Toolset "${id}" is already registered by this extension`);
      handlers.set(id, handler);
      const registered = rpc.request<{ tools: string[] }>("mcp:registerToolset", { extensionId, toolset }).then(
        (answer) => answer.tools,
        (error: unknown) => {
          forget(id, handler);
          console.error(`[ppm.mcp] toolset "${id}" was refused:`, error instanceof Error ? error.message : error);
          throw error;
        },
      );
      // Already logged; an extension that never awaits it must not leave an unhandled rejection.
      registered.catch(() => {});
      let disposed = false;
      return {
        registered,
        dispose() {
          if (disposed) return;
          disposed = true;
          forget(id, handler);
          rpc.request("mcp:unregisterToolset", { extensionId, toolsetId: id }).catch(() => {});
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
      controller.abort(abortError());
      return true;
    },
    dispose() {
      for (const controller of running.values()) controller.abort(abortError());
      running.clear();
      handlers.clear();
    },
  };

  return { api, host };
}
