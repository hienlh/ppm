/**
 * `ppm.chat.bind` / `unbind` / `getBinding` — instructions, toolsets and a tool policy an
 * extension attaches to a Claude session it created with `bindable: true`. The extension id
 * is whatever the worker says it is (every extension shares that channel), so ownership
 * confines a mistaken extension, not a hostile one; see `extension-session-binding.service.ts`.
 *
 * A change is put in force by restarting the session's live subprocess when it is idle, or at
 * its next idle moment; `pendingRestart` tells the extension it is the latter, in which case
 * the running turn (or background work) finishes under the binding it started with.
 */
import type { RpcChannel } from "../extension-rpc.ts";
import { bindSession, getOwnedBinding, unbindSession } from "../extension-session-binding.service.ts";
import type { ExtensionSessionBinding } from "../../shared/extension-session-binding.ts";
import { extensionMcpTokens } from "../extension-mcp/extension-mcp-tokens.ts";

type Params = Record<string, unknown>;

const chatSocket = () => import("../../server/ws/chat.ts");

function paramsOf(params: unknown[]): Params {
  const first = params[0];
  return first && typeof first === "object" ? first as Params : {};
}

function requireString(p: Params, key: string): string {
  const value = p[key];
  if (typeof value !== "string" || !value) throw new Error(`${key} is required`);
  return value;
}

/** What a turn runs under; nothing else in a binding needs the subprocess restarted. */
const turnShape = (b: ExtensionSessionBinding) => JSON.stringify([b.instructions, b.toolsets, b.toolPolicy]);

/**
 * Restart the live subprocess if the change matters to it; true while that restart is still to
 * come. Once no query is left holding the session's `ppm-ext` token it is revoked, and the next
 * query gets a fresh one if the binding still names toolsets; until then the endpoint itself
 * answers by the new binding, so a running turn's calls to a dropped toolset are error results.
 */
async function putInForce(before: ExtensionSessionBinding, after: ExtensionSessionBinding): Promise<boolean> {
  if (turnShape(before) === turnShape(after)) return false;
  const { pendingRestart } = (await chatSocket()).applyBindingChange(after.sessionId);
  if (!pendingRestart) extensionMcpTokens.revoke(after.sessionId);
  return pendingRestart;
}

export function registerExtensionChatBindingHandlers(rpc: RpcChannel): void {
  rpc.onRequest("chat:bind", async (params) => {
    const p = paramsOf(params);
    const sessionId = requireString(p, "sessionId");
    const extensionId = requireString(p, "extensionId");
    const before = getOwnedBinding(sessionId, extensionId);
    const binding = bindSession(sessionId, extensionId, p.binding);
    return { ...binding, pendingRestart: await putInForce(before, binding) };
  });

  rpc.onRequest("chat:unbind", async (params) => {
    const p = paramsOf(params);
    const sessionId = requireString(p, "sessionId");
    const extensionId = requireString(p, "extensionId");
    const before = getOwnedBinding(sessionId, extensionId);
    unbindSession(sessionId, extensionId);
    return { unbound: true, pendingRestart: await putInForce(before, getOwnedBinding(sessionId, extensionId)) };
  });

  rpc.onRequest("chat:getBinding", async (params) => {
    const p = paramsOf(params);
    return getOwnedBinding(requireString(p, "sessionId"), requireString(p, "extensionId"));
  });
}
