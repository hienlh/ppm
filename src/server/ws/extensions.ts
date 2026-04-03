/**
 * WebSocket handler for extension UI bridge.
 * Routes messages between browser clients and the extension host.
 */
import { contributionRegistry } from "../../services/contribution-registry.ts";
import type { ExtServerMsg, ExtClientMsg } from "../../types/extension-messages.ts";

type ExtWsSocket = {
  data: { type: string };
  send: (data: string) => void;
};

/** All connected extension WS clients */
const clients = new Set<ExtWsSocket>();

/** Pending request resolvers for quickpick/inputbox responses from browser */
const pendingRequests = new Map<string, (value: unknown) => void>();

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
 * Returns the resolved value or undefined on timeout.
 */
export function requestFromBrowser<T = unknown>(
  msg: ExtServerMsg,
  trackingId: string,
  timeoutMs = 30_000,
): Promise<T | undefined> {
  broadcastExtMsg(msg);
  return new Promise<T | undefined>((resolve) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(trackingId);
      resolve(undefined);
    }, timeoutMs);
    pendingRequests.set(trackingId, (value) => {
      clearTimeout(timer);
      resolve(value as T);
    });
  });
}

/** Get the number of connected extension WS clients */
export function getExtClientCount(): number {
  return clients.size;
}

// --- WS lifecycle handlers ---

function handleOpen(ws: ExtWsSocket): void {
  clients.add(ws);
  console.log(`[ExtWS] Client connected (${clients.size} total)`);
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
      // Send current contributions on connect
      const contributions = contributionRegistry.getAll();
      ws.send(JSON.stringify({ type: "contributions:update", contributions } satisfies ExtServerMsg));
      break;
    }

    case "command:execute": {
      try {
        const { extensionService } = await import("../../services/extension.service.ts");
        // Forward to extension host worker via RPC
        if (extensionService["rpc"]) {
          await extensionService["rpc"].sendRequest("ext:command:execute", msg.command, ...(msg.args ?? []));
        }
      } catch (e) {
        console.error(`[ExtWS] command:execute error:`, e);
      }
      break;
    }

    case "tree:click": {
      if (msg.command) {
        try {
          const { extensionService } = await import("../../services/extension.service.ts");
          if (extensionService["rpc"]) {
            await extensionService["rpc"].sendRequest("ext:command:execute", msg.command);
          }
        } catch (e) {
          console.error(`[ExtWS] tree:click command error:`, e);
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

    case "notification:action": {
      const resolver = pendingRequests.get(msg.id);
      if (resolver) {
        pendingRequests.delete(msg.id);
        resolver(msg.action);
      }
      break;
    }

    case "webview:message": {
      // Phase 5: forward to extension's onDidReceiveMessage handler
      console.log(`[ExtWS] webview:message for panel ${msg.panelId}`);
      break;
    }

    case "tree:expand": {
      // Phase 5: call TreeDataProvider.getChildren(itemId)
      console.log(`[ExtWS] tree:expand ${msg.viewId}/${msg.itemId}`);
      break;
    }
  }
}

function handleClose(ws: ExtWsSocket): void {
  clients.delete(ws);
  console.log(`[ExtWS] Client disconnected (${clients.size} remaining)`);
}

export const extensionWebSocket = {
  open: handleOpen,
  message: handleMessage,
  close: handleClose,
};
