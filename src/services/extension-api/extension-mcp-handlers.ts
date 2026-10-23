/**
 * `ppm.mcp.registerToolset` — the main side. A registration lands in the shared registry with a
 * function that forwards each call back over this worker's channel as `ext:mcp:call`; the
 * worker routes it to the handler of the extension the call names.
 *
 * The extension id comes from the worker, which every extension shares, so it is checked to be
 * an installed, enabled extension and nothing more; the registry's first-registration-wins rule
 * keeps a running toolset from being taken over. A forwarded call is registered under this
 * worker's generation, so rebuilding the worker cancels it, and it ends with `ext:mcp:cancel`
 * when the model's HTTP request goes away (the user stopped the turn).
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
    const why = (): ExtensionMcpToolResult => ({
      text: call.signal.aborted ? "The extension host restarted, so the call was cancelled. Try again." : "The call was cancelled.",
      isError: true,
    });
    try {
      if (stop.signal.aborted) return why();
      const callId = crypto.randomUUID();
      const answer = rpc.sendRequestWithTimeout<unknown>("ext:mcp:call", EXTENSION_TOOL_CALL_TIMEOUT_MS, [
        { extensionId, toolsetId, name, args, ctx, callId },
      ]);
      const cancelled = new Promise<ExtensionMcpToolResult>((resolve) => {
        stop.signal.addEventListener("abort", () => {
          rpc.sendRequest("ext:mcp:cancel", { extensionId, callId }).catch(() => {});
          resolve(why());
        }, { once: true });
      });
      return await Promise.race([answer, cancelled]);
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
    const toolset = deps.registry.register(
      extensionId, checked, workerToolInvoker(rpc, api, extensionId, checked.id), api.generation,
    );
    log.info(`${loggableExtensionId(extensionId)} registered toolset ${toolset.id} (${toolset.tools.length} tools)`);
    return { tools: toolset.tools.map((tool) => exposedToolName(toolset.id, tool.name)) };
  });

  rpc.onRequest("mcp:unregisterToolset", async (params) => {
    const p = paramsOf(params);
    const extensionId = requireExtension(p, deps);
    if (typeof p.toolsetId !== "string") throw new Error("toolsetId is required");
    return { unregistered: deps.registry.unregister(extensionId, p.toolsetId, api.generation) };
  });
}
