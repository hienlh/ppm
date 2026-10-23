/**
 * `ppm.chat.bind` / `unbind` / `getBinding` — instructions, toolsets and a tool policy an
 * extension attaches to a Claude session it created with `bindable: true`. The extension id
 * is whatever the worker says it is (every extension shares that channel), so ownership
 * confines a mistaken extension, not a hostile one; see `extension-session-binding.service.ts`.
 */
import type { RpcChannel } from "../extension-rpc.ts";
import { bindSession, getOwnedBinding, unbindSession } from "../extension-session-binding.service.ts";

type Params = Record<string, unknown>;

function paramsOf(params: unknown[]): Params {
  const first = params[0];
  return first && typeof first === "object" ? first as Params : {};
}

function requireString(p: Params, key: string): string {
  const value = p[key];
  if (typeof value !== "string" || !value) throw new Error(`${key} is required`);
  return value;
}

export function registerExtensionChatBindingHandlers(rpc: RpcChannel): void {
  rpc.onRequest("chat:bind", async (params) => {
    const p = paramsOf(params);
    return bindSession(requireString(p, "sessionId"), requireString(p, "extensionId"), p.binding);
  });

  rpc.onRequest("chat:unbind", async (params) => {
    const p = paramsOf(params);
    unbindSession(requireString(p, "sessionId"), requireString(p, "extensionId"));
    return { unbound: true };
  });

  rpc.onRequest("chat:getBinding", async (params) => {
    const p = paramsOf(params);
    return getOwnedBinding(requireString(p, "sessionId"), requireString(p, "extensionId"));
  });
}
