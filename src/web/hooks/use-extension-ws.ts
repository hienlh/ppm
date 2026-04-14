import { useEffect, useCallback, useRef } from "react";
import { WsClient } from "@/lib/ws-client";
import { useExtensionStore } from "@/stores/extension-store";
import { useTabStore } from "@/stores/tab-store";
import { getAuthToken } from "@/lib/api-client";
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

    // Pass auth token as query param for WS auth
    const token = getAuthToken();
    const wsUrl = token ? `/ws/extensions?token=${encodeURIComponent(token)}` : "/ws/extensions";
    const client = new WsClient(wsUrl);
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
          if (msg.parentId) {
            store.updateTreeChildren(msg.viewId, msg.parentId, msg.items);
          } else {
            store.updateTree(msg.viewId, msg.items);
          }
          break;

        case "tree:refresh":
          store.removeTree(msg.viewId);
          break;

        case "notification": {
          const toastFn = msg.level === "error" ? toast.error
            : msg.level === "warn" ? toast.warning
            : toast.info;
          if (msg.actions && msg.actions.length > 0) {
            const toastOpts: Record<string, unknown> = {
              action: {
                label: msg.actions[0],
                onClick: () => send({ type: "notification:action", id: msg.id, action: msg.actions![0] ?? null }),
              },
              onDismiss: () => send({ type: "notification:action", id: msg.id, action: null }),
            };
            // Support a second action button via cancel
            if (msg.actions.length > 1) {
              toastOpts.cancel = {
                label: msg.actions[1],
                onClick: () => send({ type: "notification:action", id: msg.id, action: msg.actions![1] ?? null }),
              };
            }
            toastFn(msg.message, toastOpts);
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

        case "webview:create": {
          const viewTypeSlug = msg.viewType.replace(/\.view$/, "");
          store.addWebviewPanel({
            id: msg.panelId,
            extensionId: msg.extensionId,
            viewType: msg.viewType,
            title: msg.title,
            html: "",
          });
          // Open a tab — use stable viewType slug as identifier (survives reload)
          // Include projectName so reload can resolve project path for re-trigger
          const currentProject = useTabStore.getState().currentProject;
          useTabStore.getState().openTab({
            type: "extension",
            title: msg.title,
            projectId: null,
            closable: true,
            metadata: { viewType: viewTypeSlug, panelId: msg.panelId, extensionId: msg.extensionId, ...(currentProject && { projectName: currentProject }) },
          });
          break;
        }

        case "webview:html":
          store.updateWebviewPanel(msg.panelId, { html: msg.html });
          break;

        case "webview:dispose":
          store.removeWebviewPanel(msg.panelId);
          break;

        case "webview:postMessage":
          window.dispatchEvent(new CustomEvent("ext:webview:message", {
            detail: { panelId: msg.panelId, message: msg.message },
          }));
          break;

        case "tab:open":
          useTabStore.getState().openTab({
            type: (msg as any).tabType,
            title: (msg as any).title,
            projectId: (msg as any).projectId ?? null,
            closable: (msg as any).closable ?? true,
            metadata: (msg as any).metadata,
          });
          break;

        case "project:switch":
          useTabStore.getState().switchProject((msg as any).projectName);
          break;
      }
    });

    // Listen for iframe→server messages (dispatched by ExtensionWebview component)
    const webviewSendHandler = (e: Event) => {
      const { panelId, message } = (e as CustomEvent).detail;
      client.send(JSON.stringify({ type: "webview:message", panelId, message }));
    };
    window.addEventListener("ext:webview:send", webviewSendHandler);

    // Listen for tree:expand requests (dispatched by ExtensionTreeView component)
    const treeExpandHandler = (e: Event) => {
      const { viewId, itemId } = (e as CustomEvent).detail;
      client.send(JSON.stringify({ type: "tree:expand", viewId, itemId }));
    };
    window.addEventListener("ext:tree:expand", treeExpandHandler);

    // Listen for command:execute requests (dispatched by StatusBar / TreeView)
    const commandHandler = (e: Event) => {
      const { command, args } = (e as CustomEvent).detail;
      client.send(JSON.stringify({ type: "command:execute", command, args }));
    };
    window.addEventListener("ext:command:execute", commandHandler);

    client.connect();

    return () => {
      window.removeEventListener("ext:webview:send", webviewSendHandler);
      window.removeEventListener("ext:tree:expand", treeExpandHandler);
      window.removeEventListener("ext:command:execute", commandHandler);
      client.disconnect();
      clientRef.current = null;
    };
  }, [send, enabled]);

  return { send };
}
