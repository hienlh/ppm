import { useEffect, useCallback, useRef } from "react";
import { WsClient } from "@/lib/ws-client";
import { useExtensionStore } from "@/stores/extension-store";
import { useTabStore } from "@/stores/tab-store";
import { usePanelStore } from "@/stores/panel-store";
import { getAuthToken } from "@/lib/api-client";
import type { ExtServerMsg, ExtClientMsg } from "../../types/extension-messages.ts";
import { toast } from "sonner";

/**
 * Track recently closed extension views to prevent auto-reopen.
 * Keyed by `${viewTypeSlug}:${projectName ?? ""}` so closing a view in one
 * project doesn't block opening the same view for another project.
 * If a `webview:create` arrives for a recently closed view, we skip
 * creating a new tab (the close was intentional).
 * Cleared when user explicitly dispatches a command for the same viewType.
 */
const recentlyClosedViews = new Set<string>();

function closedViewKey(slug: string, projectName?: string): string {
  return `${slug}:${projectName ?? ""}`;
}

/**
 * Track views whose command THIS browser tab dispatched. `webview:create`
 * is broadcast to every connected client — only the client that asked for the
 * view may create a new tab; others must at most rebind an existing tab.
 * Keyed by `${slug}:${projectPath ?? ""}` so concurrent opens of the same
 * extension for different projects (or another client's broadcast) can't
 * consume each other's entry. Entries expire after 15s in case the command
 * fails silently.
 */
const locallyDispatchedViews = new Map<string, number>();
const LOCAL_DISPATCH_TTL_MS = 15_000;

/** Consume a pending local dispatch matching this create event. */
function takeLocalDispatch(slug: string, projectPath?: string): boolean {
  const now = Date.now();
  for (const [k, t] of locallyDispatchedViews) {
    if (now - t > LOCAL_DISPATCH_TTL_MS) locallyDispatchedViews.delete(k);
  }
  if (locallyDispatchedViews.delete(`${slug}:${projectPath ?? ""}`)) return true;
  // Path-less dispatch (extension resolved the project itself) matched by a
  // path-carrying create — consume the bare entry
  if (projectPath && locallyDispatchedViews.delete(`${slug}:`)) return true;
  // Legacy: extension created its panel without projectPath — consume any
  // pending dispatch for this slug (dispatch args may still have carried one)
  if (!projectPath) {
    for (const k of locallyDispatchedViews.keys()) {
      if (k.startsWith(`${slug}:`)) {
        locallyDispatchedViews.delete(k);
        return true;
      }
    }
  }
  return false;
}

/**
 * Track viewTypes whose command dispatch was auto-recovery (not user-initiated).
 * When `webview:create` arrives for a recovery viewType, skip setActiveTab
 * to prevent stealing focus from the user's current tab.
 */
const recoveryViews = new Set<string>();

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
          if (msg.activationErrors) {
            const prev = store.activationErrors;
            store.setActivationErrors(msg.activationErrors);
            // Only toast NEW errors (avoid spam on repeated contributions:update)
            for (const [extId, error] of Object.entries(msg.activationErrors)) {
              if (!prev[extId]) toast.error(`Extension "${extId}" failed to activate: ${error}`);
            }
          }
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
          const locallyRequested = takeLocalDispatch(viewTypeSlug, msg.projectPath);
          store.addWebviewPanel({
            id: msg.panelId,
            extensionId: msg.extensionId,
            viewType: msg.viewType,
            title: msg.title,
            html: "",
            projectName: msg.projectName,
          });
          // Find an existing tab for this viewType AND project. Panels for
          // non-active project grids stay in the store, so search all panels —
          // a panel recreate must rebind that project's tab wherever it lives.
          const baseTabId = `extension:${viewTypeSlug}`;
          const ps = usePanelStore.getState();
          const candidates = Object.values(ps.panels)
            .flatMap((p) => p.tabs)
            .filter((tab) => tab.id === baseTabId || tab.id.startsWith(`${baseTabId}@`));
          const tabProject = (tab: { metadata?: Record<string, unknown> }) =>
            tab.metadata?.projectName as string | undefined;
          // Exact project match first; legacy tabs (no projectName) fall back;
          // never adopt a tab bound to a DIFFERENT project
          const existingTab = msg.projectName
            ? candidates.find((t) => tabProject(t) === msg.projectName)
              ?? candidates.find((t) => !tabProject(t))
            : candidates[0];
          if (existingTab) {
            // Panel was recreated for this project — rebind tab to new panelId.
            // Preserve existing metadata since updateTab replaces metadata entirely.
            useTabStore.getState().updateTab(existingTab.id, {
              title: msg.title,
              metadata: {
                ...existingTab.metadata,
                viewType: viewTypeSlug,
                panelId: msg.panelId,
                extensionId: msg.extensionId,
                ...(msg.projectName && { projectName: msg.projectName }),
              },
            });
            // Focus only if THIS browser tab explicitly opened it (not
            // auto-recovery, not another browser tab's broadcast)
            if (locallyRequested && !recoveryViews.has(viewTypeSlug)) {
              useTabStore.getState().setActiveTab(existingTab.id);
            }
            recoveryViews.delete(viewTypeSlug);
          } else if (locallyRequested && !recentlyClosedViews.has(closedViewKey(viewTypeSlug, msg.projectName))) {
            // Only the client that dispatched the command creates a new tab —
            // broadcasts triggered by other browser tabs are ignored here
            const currentProject = useTabStore.getState().currentProject;
            const projectName = msg.projectName ?? currentProject ?? undefined;
            useTabStore.getState().openTab({
              type: "extension",
              title: msg.title,
              projectId: null,
              closable: true,
              metadata: { viewType: viewTypeSlug, panelId: msg.panelId, extensionId: msg.extensionId, ...(projectName && { projectName }) },
            });
          }
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
      const { command, args, recovery } = (e as CustomEvent).detail;
      // User explicitly opened an extension — clear "recently closed" (all
      // projects for this slug; dispatch args carry a path, not a project name)
      const slug = (command as string).replace(/\.view$/, "");
      for (const key of recentlyClosedViews) {
        if (key.startsWith(`${slug}:`)) recentlyClosedViews.delete(key);
      }
      // This client asked for the view — allow it to create/focus the tab
      // when the broadcast `webview:create` arrives (TTL-expired on read).
      // args[0] is the projectPath for view commands that carry one.
      const dispatchPath = Array.isArray(args) && typeof args[0] === "string" ? args[0] : "";
      locallyDispatchedViews.set(`${slug}:${dispatchPath}`, Date.now());
      // Track recovery dispatches to avoid stealing focus on webview:create
      if (recovery) recoveryViews.add(slug);
      else recoveryViews.delete(slug);
      client.send(JSON.stringify({ type: "command:execute", command, args }));
    };
    window.addEventListener("ext:command:execute", commandHandler);

    // Listen for webview close requests (dispatched by ExtensionWebview on unmount)
    const webviewCloseHandler = (e: Event) => {
      const { panelId, viewType, projectName } = (e as CustomEvent).detail;
      client.send(JSON.stringify({ type: "webview:close", panelId }));
      // Track that user intentionally closed this extension tab (per project)
      if (viewType) {
        const slug = (viewType as string).replace(/\.view$/, "");
        const key = closedViewKey(slug, projectName as string | undefined);
        recentlyClosedViews.add(key);
        // Auto-clear after 5s — stale entries are harmless but could block
        // legitimate reopens if user waits too long
        setTimeout(() => recentlyClosedViews.delete(key), 5_000);
      }
    };
    window.addEventListener("ext:webview:close", webviewCloseHandler);

    client.connect();

    return () => {
      window.removeEventListener("ext:webview:send", webviewSendHandler);
      window.removeEventListener("ext:tree:expand", treeExpandHandler);
      window.removeEventListener("ext:command:execute", commandHandler);
      window.removeEventListener("ext:webview:close", webviewCloseHandler);
      client.disconnect();
      clientRef.current = null;
    };
  }, [send, enabled]);

  return { send };
}
