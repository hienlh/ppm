/**
 * `ppm.mcp.registerToolset` — the main side. A registration lands in the shared registry with a
 * function that forwards each call back over this worker's channel as `ext:mcp:call`; the worker
 * routes it to the handler of the extension the call names.
 *
 * The extension id comes from the worker, which every extension shares, so it is checked to be an
 * installed, enabled extension and nothing more. What actually keeps a running toolset from being
 * taken over is the opaque handle the registry hands back on `register`: `unregister` must name
 * it exactly, and the vscode-compat wrapper is the only thing that holds it, in a closure the
 * worker's other extensions cannot read without sniffing the RPC response. A forwarded call is
 * registered under this worker's generation, so rebuilding the worker cancels it, and it ends
 * with `ext:mcp:cancel` both when the model's HTTP request goes away (the user stopped the turn)
 * and when the call outlives its own time limit, so a handler that ignores that is still told to
 * stop rather than left holding the slot until the limit's own timer fires on its own.
 */
import type { RpcChannel } from "../extension-rpc.ts";
import type { ExtensionApiDeps } from "./index.ts";
import { getExtensionById } from "../db.service.ts";
import { createLogger } from "../logger.ts";
import { isExtensionId, loggableExtensionId } from "../extension-ai/extension-ai-request.ts";
import { extensionMcpRegistry, type ExtensionMcpRegistry, type ExtensionToolInvoker } from "../extension-mcp/extension-mcp-registry.ts";
import { EXTENSION_TOOL_CALL_TIMEOUT_MS, exposedToolName, validateToolset, type ExtensionMcpToolResult } from "../../shared/extension-mcp.ts";

const log = createLogger("extension-mcp");

export interface ExtensionMcpHandlerDeps {
  registry: Pick<ExtensionMcpRegistry, "register" | "unregister">;
  isKnownExtension(id: string): boolean;
  /** Overridable in tests; production always uses the real per-call ceiling. */
  callTimeoutMs?: number;
}

const defaultDeps: ExtensionMcpHandlerDeps = {
  registry: extensionMcpRegistry,
  isKnownExtension: (id) => getExtensionById(id)?.enabled === 1,
};

function paramsOf(params: unknown[]): Record<string, unknown> {
  const first = params[0];
  return first && typeof first === "object" ? first as Record<string, unknown> : {};
}

function requireExtension(p: Record<string, unknown>, deps: ExtensionMcpHandlerDeps): string {
  if (!isExtensionId(p.extensionId) || !deps.isKnownExtension(p.extensionId)) {
    throw new Error("extensionId must name an installed, enabled extension");
  }
  return p.extensionId;
}

/** Sends one call to this channel's worker; settles with an error result when it is cancelled. */
export function workerToolInvoker(
  rpc: RpcChannel, api: Pick<ExtensionApiDeps, "beginCall">, extensionId: string, toolsetId: string,
  timeoutMs: number = EXTENSION_TOOL_CALL_TIMEOUT_MS,
): ExtensionToolInvoker {
  return async (name, args, ctx, signal) => {
    const call = api.beginCall();
    const stop = new AbortController();
    const link = (s: AbortSignal) => {
      if (s.aborted) stop.abort(s.reason);
      else s.addEventListener("abort", () => stop.abort(s.reason), { once: true });
    };
    link(call.signal);
    link(signal);
    const callId = crypto.randomUUID();
    const sendCancel = () => { rpc.sendRequest("ext:mcp:cancel", { extensionId, callId }).catch(() => {}); };
    const why = (): ExtensionMcpToolResult => ({
      text: call.signal.aborted ? "The extension host restarted, so the call was cancelled. Try again." : "The call was cancelled.",
      isError: true,
    });
    try {
      if (stop.signal.aborted) return why();
      const answer = rpc.sendRequestWithTimeout<unknown>("ext:mcp:call", timeoutMs, [
        { extensionId, toolsetId, name, args, ctx, callId },
      ]).catch((e) => {
        // The worker-side handler is still running and holding whatever it holds: tell it to
        // stop rather than leave it be just because nobody is waiting on it any more.
        sendCancel();
        throw new Error(`The extension's tool did not answer within ${timeoutMs}ms: ${e instanceof Error ? e.message : String(e)}`);
      });
      const cancelled = new Promise<ExtensionMcpToolResult>((resolve) => {
        stop.signal.addEventListener("abort", () => {
          sendCancel();
          resolve(why());
        }, { once: true });
      });
      return await Promise.race([answer, cancelled]) as ExtensionMcpToolResult;
    } catch (e) {
      return { text: e instanceof Error ? e.message : String(e), isError: true };
    } finally {
      call.end();
    }
  };
}

export function registerExtensionMcpHandlers(
  rpc: RpcChannel, api: ExtensionApiDeps, deps: ExtensionMcpHandlerDeps = defaultDeps,
): void {
  rpc.onRequest("mcp:registerToolset", async (params) => {
    const p = paramsOf(params);
    const extensionId = requireExtension(p, deps);
    const checked = validateToolset(p.toolset);
    const { toolset, handle } = deps.registry.register(
      extensionId, checked, workerToolInvoker(rpc, api, extensionId, checked.id, deps.callTimeoutMs),
    );
    log.info(`${loggableExtensionId(extensionId)} registered toolset ${toolset.id} (${toolset.tools.length} tools)`);
    return { tools: toolset.tools.map((tool) => exposedToolName(toolset.id, tool.name)), handle };
  });

  rpc.onRequest("mcp:unregisterToolset", async (params) => {
    const p = paramsOf(params);
    const extensionId = requireExtension(p, deps);
    if (typeof p.toolsetId !== "string") throw new Error("toolsetId is required");
    if (typeof p.handle !== "string" || !p.handle) throw new Error("handle is required: only the registration that received it may unregister");
    return { unregistered: deps.registry.unregister(extensionId, p.toolsetId, p.handle) };
  });
}
