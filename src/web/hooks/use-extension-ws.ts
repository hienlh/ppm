import { useEffect, useCallback, useRef } from "react";
import { WsClient } from "@/lib/ws-client";
import { useExtensionStore } from "@/stores/extension-store";
import type { ExtServerMsg, ExtClientMsg } from "../../types/extension-messages.ts";
import { toast } from "sonner";

/**
 * Hook that manages the WebSocket connection for extension UI bridge.
 * Dispatches server messages into the extension Zustand store.
 * Only connects when `enabled` is true (after auth).
 */
export function useExtensionWs(enabled = true) {
  const clientRef = useRef<WsClient | null>(null);

  const send = useCallback((msg: ExtClientMsg) => {
    clientRef.current?.send(JSON.stringify(msg));
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const client = new WsClient("/ws/extensions");
    clientRef.current = client;

    client.onMessage((event) => {
      let msg: ExtServerMsg;
      try {
        msg = JSON.parse(event.data) as ExtServerMsg;
      } catch {
        return;
      }

      const store = useExtensionStore.getState();

      switch (msg.type) {
        case "contributions:update":
          store.setContributions(msg.contributions);
          break;

        case "statusbar:update":
          store.addStatusBarItem(msg.item);
          break;

        case "statusbar:remove":
          store.removeStatusBarItem(msg.itemId);
          break;

        case "tree:update":
          store.updateTree(msg.viewId, msg.items);
          break;

        case "tree:refresh":
          // Re-request tree data — for now clear to trigger re-render
          store.removeTree(msg.viewId);
          break;

        case "notification": {
          const toastFn = msg.level === "error" ? toast.error
            : msg.level === "warn" ? toast.warning
            : toast.info;
          if (msg.actions && msg.actions.length > 0) {
            toastFn(msg.message, {
              action: {
                label: msg.actions[0],
                onClick: () => send({ type: "notification:action", id: msg.id, action: msg.actions![0] ?? null }),
              },
              onDismiss: () => send({ type: "notification:action", id: msg.id, action: null }),
            });
          } else {
            toastFn(msg.message);
          }
          break;
        }

        case "quickpick:show":
          store.showQuickPick(
            msg.items,
            msg.options,
          ).then((selected) => {
            send({
              type: "quickpick:resolve",
              requestId: msg.requestId,
              selected: selected ?? null,
            });
          });
          break;

        case "inputbox:show":
          store.showInputBox(msg.options).then((value) => {
            send({
              type: "inputbox:resolve",
              requestId: msg.requestId,
              value: value ?? null,
            });
          });
          break;

        case "webview:create":
          store.addWebviewPanel({
            id: msg.panelId,
            extensionId: msg.extensionId,
            viewType: msg.viewType,
            title: msg.title,
            html: "",
          });
          break;

        case "webview:html":
          store.updateWebviewPanel(msg.panelId, { html: msg.html });
          break;

        case "webview:dispose":
          store.removeWebviewPanel(msg.panelId);
          break;

        case "webview:postMessage":
          // Forward to iframe — handled by ExtensionWebview component
          // via a custom event on window
          window.dispatchEvent(new CustomEvent("ext:webview:message", {
            detail: { panelId: msg.panelId, message: msg.message },
          }));
          break;
      }
    });

    // Listen for iframe→server messages (dispatched by ExtensionWebview component)
    const webviewSendHandler = (e: Event) => {
      const { panelId, message } = (e as CustomEvent).detail;
      client.send(JSON.stringify({ type: "webview:message", panelId, message }));
    };
    window.addEventListener("ext:webview:send", webviewSendHandler);

    client.connect();

    return () => {
      window.removeEventListener("ext:webview:send", webviewSendHandler);
      client.disconnect();
      clientRef.current = null;
    };
  }, [send]);

  return { send };
}
