/**
 * Main-side handlers for PPM's own extension API (`api.ppm.*` in vscode-compat). Each area
 * lives in a file of its own and registers here, so the VSCode-shaped handlers in
 * `extension-rpc-handlers.ts` do not have to grow with it.
 */
import type { RpcChannel } from "../extension-rpc.ts";
import { extensionCallRegistry, type ExtensionCall, type ExtensionCallRegistry } from "./extension-call-registry.ts";
import { registerExtensionChatHandlers } from "./extension-chat-handlers.ts";
import { registerExtensionChatBindingHandlers } from "./extension-chat-binding-handlers.ts";

/** What a handler is given besides the channel: which worker it serves, and how to tie a
 *  long-running call to that worker's life. */
export interface ExtensionApiDeps {
  /** The worker generation this channel belongs to. */
  generation: number;
  /** Start a call that is aborted when this generation's worker is torn down. */
  beginCall(): ExtensionCall;
}

export function extensionApiDeps(
  generation: number,
  registry: ExtensionCallRegistry = extensionCallRegistry,
): ExtensionApiDeps {
  return { generation, beginCall: () => registry.begin(generation) };
}

/** Register every `ppm:*` handler on a worker's channel. Called once per channel. */
export function registerExtensionApiHandlers(rpc: RpcChannel, _deps: ExtensionApiDeps): void {
  registerExtensionChatHandlers(rpc);
  registerExtensionChatBindingHandlers(rpc);
}
