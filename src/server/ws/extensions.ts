/**
 * WebSocket handler for extension UI bridge.
 * Routes messages between browser clients and the extension host.
 */
import { contributionRegistry } from "../../services/contribution-registry.ts";
import type { ExtServerMsg, ExtClientMsg } from "../../types/extension-messages.ts";
import { createLogger } from "../../services/logger.ts";

const log = createLogger("ExtWS");

type ExtWsSocket = {
  data: { type: string };
  send: (data: string) => void;
};

/** All connected extension WS clients */
const clients = new Set<ExtWsSocket>();

/** Pending request resolvers for quickpick/inputbox responses from browser */
const pendingRequests = new Map<string, (value: unknown) => void>();

/** Each socket's id, told to the browser on connect so a `tab:open` can be addressed to it. */
const clientIds = new WeakMap<ExtWsSocket, string>();

/** The browser that last ran each extension's command, so a tab the command opens lands there. */
const lastCommandClients = new Map<string, { clientId: string; at: number }>();

/** How long after a command its browser is still "the one that ran it". */
export const COMMAND_CLIENT_TTL_MS = 10_000;

/** The id of the browser that ran one of `extensionId`'s commands within the TTL, if any. */
export function recentCommandClient(extensionId: string, now = Date.now()): string | null {
  const last = lastCommandClients.get(extensionId);
  if (!last || now - last.at > COMMAND_CLIENT_TTL_MS) return null;
  return last.clientId;
}

function rememberCommandClient(ws: ExtWsSocket, command: string): void {
  const owner = contributionRegistry.getCommandOwner(command);
  const clientId = clientIds.get(ws);
  if (owner && clientId) lastCommandClients.set(owner, { clientId, at: Date.now() });
}

// --- Public API for extension service to push UI updates ---

/** Broadcast a message to all connected extension WS clients */
export function broadcastExtMsg(msg: ExtServerMsg): void {
  const data = JSON.stringify(msg);
  for (const ws of clients) {
    try { ws.send(data); } catch {}
  }
}

/**
 * Send a request to browser and wait for response (quickpick, inputbox, notification).
 * The `trackingId` is the key used to match the response.
 * Returns the resolved value, or undefined on timeout or once `signal` aborts (the extension
 * host that asked was rebuilt, so nobody is left to read the answer).
 */
export function requestFromBrowser<T = unknown>(
  msg: ExtServerMsg,
  trackingId: string,
  timeoutMs = 30_000,
  signal?: AbortSignal,
): Promise<T | undefined> {
  if (signal?.aborted) return Promise.resolve(undefined);
  broadcastExtMsg(msg);
  return new Promise<T | undefined>((resolve) => {
    const settle = (value: T | undefined) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      pendingRequests.delete(trackingId);
      resolve(value);
    };
    const onAbort = () => settle(undefined);
    const timer = setTimeout(onAbort, timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    pendingRequests.set(trackingId, (value) => settle(value as T));
  });
}

/** Get the number of connected extension WS clients */
export function getExtClientCount(): number {
  return clients.size;
}

// --- WS lifecycle handlers ---

function handleOpen(ws: ExtWsSocket): void {
  clients.add(ws);
  clientIds.set(ws, crypto.randomUUID());
  log.debug(`Client connected (${clients.size} total)`);
}

async function handleMessage(ws: ExtWsSocket, raw: string | Buffer): Promise<void> {
  let msg: ExtClientMsg;
  try {
    msg = JSON.parse(typeof raw === "string" ? raw : raw.toString()) as ExtClientMsg;
  } catch {
    return;
  }

  switch (msg.type) {
    case "ready": {
      // The browser's name for itself here, ahead of everything else it is sent.
      const clientId = clientIds.get(ws);
      if (clientId) ws.send(JSON.stringify({ type: "client:hello", clientId } satisfies ExtServerMsg));
      // Send current contributions + any activation errors on connect
      const contributions = contributionRegistry.getAll();
      const { extensionService } = await import("../../services/extension.service.ts");
      const activationErrors = Object.fromEntries(extensionService.getActivationErrors());
      const readyMsg: ExtServerMsg = Object.keys(activationErrors).length > 0
        ? { type: "contributions:update", contributions, activationErrors }
        : { type: "contributions:update", contributions };
      ws.send(JSON.stringify(readyMsg));
      break;
    }

    case "command:execute": {
      rememberCommandClient(ws, msg.command);
      try {
        const { extensionService } = await import("../../services/extension.service.ts");
        if (extensionService["rpc"]) {
          log.debug(`command:execute "${msg.command}"`);
          const result = await extensionService["rpc"].sendRequest<{ ok: boolean; error?: string }>(
            "ext:command:execute", msg.command, ...(msg.args ?? []),
          );
          if (!result?.ok) {
            log.error(`command:execute failed: ${result?.error ?? "unknown"}`);
            broadcastExtMsg({
              type: "notification",
              id: `cmd-error-${Date.now()}`,
              level: "error",
              message: `Extension command failed: ${result?.error ?? "unknown error"}`,
            });
          }
        } else {
          log.error(`command:execute: extension host not ready`);
          broadcastExtMsg({
            type: "notification",
            id: `cmd-error-${Date.now()}`,
            level: "error",
            message: `Extension host not ready. Try reloading the page.`,
          });
        }
      } catch (e) {
        log.error(`command:execute error:`, e);
        broadcastExtMsg({
          type: "notification",
          id: `cmd-error-${Date.now()}`,
          level: "error",
          message: `Extension command error: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
      break;
    }

    case "tree:click": {
      if (msg.command) {
        rememberCommandClient(ws, msg.command);
        try {
          const { extensionService } = await import("../../services/extension.service.ts");
          if (extensionService["rpc"]) {
            await extensionService["rpc"].sendRequest("ext:command:execute", msg.command);
          }
        } catch (e) {
          log.error(`tree:click command error:`, e);
        }
      }
      break;
    }

    case "quickpick:resolve": {
      const resolver = pendingRequests.get(msg.requestId);
      if (resolver) {
        pendingRequests.delete(msg.requestId);
        resolver(msg.selected);
      }
      break;
    }

    case "inputbox:resolve": {
      const resolver = pendingRequests.get(msg.requestId);
      if (resolver) {
        pendingRequests.delete(msg.requestId);
        resolver(msg.value);
      }
      break;
    }

    case "composer:resolve": {
      const resolver = pendingRequests.get(msg.requestId);
      if (resolver) {
        pendingRequests.delete(msg.requestId);
        resolver(msg.result);
      }
      break;
    }

    case "notification:action": {
      const resolver = pendingRequests.get(msg.id);
      if (resolver) {
        pendingRequests.delete(msg.id);
        resolver(msg.action);
      }
      break;
    }

    case "webview:message": {
      try {
        const { extensionService } = await import("../../services/extension.service.ts");
        if (extensionService["rpc"]) {
          await extensionService["rpc"].sendRequest("ext:webview:message", msg.panelId, msg.message);
        }
      } catch (e) {
        log.error(`webview:message error:`, e);
      }
      break;
    }

    case "webview:close": {
      try {
        const { extensionService } = await import("../../services/extension.service.ts");
        if (extensionService["rpc"]) {
          await extensionService["rpc"].sendRequest("ext:webview:close", msg.panelId);
        }
      } catch (e) {
        log.error(`webview:close error:`, e);
      }
      break;
    }

    case "tree:expand": {
      try {
        const { extensionService } = await import("../../services/extension.service.ts");
        if (extensionService["rpc"]) {
          const result = await extensionService["rpc"].sendRequest<{ ok: boolean; items?: unknown[] }>(
            "ext:tree:expand", msg.viewId, msg.itemId,
          );
          if (result?.ok && result.items) {
            // Send children back to the requesting client (parentId distinguishes child updates from root updates)
            ws.send(JSON.stringify({ type: "tree:update", viewId: msg.viewId, items: result.items as import("../../types/extension-messages.ts").TreeItemMsg[], parentId: msg.itemId } satisfies ExtServerMsg));
          }
        }
      } catch (e) {
        log.error(`tree:expand error:`, e);
      }
      break;
    }
  }
}

function handleClose(ws: ExtWsSocket): void {
  clients.delete(ws);
  log.debug(`Client disconnected (${clients.size} remaining)`);
}

export const extensionWebSocket = {
  open: handleOpen,
  message: handleMessage,
  close: handleClose,
};
