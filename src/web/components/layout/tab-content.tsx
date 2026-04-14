import { Suspense, lazy } from "react";
import { useTabStore, type TabType } from "@/stores/tab-store";
import { Loader2 } from "lucide-react";

const TAB_COMPONENTS: Record<TabType, React.LazyExoticComponent<React.ComponentType<{ metadata?: Record<string, unknown>; tabId?: string }>>> = {
  terminal: lazy(() =>
    import("@/components/terminal/terminal-tab").then((m) => ({
      default: m.TerminalTab,
    })),
  ),
  chat: lazy(() =>
    import("@/components/chat/chat-tab").then((m) => ({
      default: m.ChatTab,
    })),
  ),
  editor: lazy(() =>
    import("@/components/editor/code-editor").then((m) => ({
      default: m.CodeEditor,
    })),
  ),
  database: lazy(() =>
    import("@/components/database/database-viewer").then((m) => ({
      default: m.DatabaseViewer,
    })),
  ),
  sqlite: lazy(() =>
    import("@/components/sqlite/sqlite-viewer").then((m) => ({
      default: m.SqliteViewer,
    })),
  ),
  postgres: lazy(() =>
    import("@/components/postgres/postgres-viewer").then((m) => ({
      default: m.PostgresViewer,
    })),
  ),
  "git-diff": lazy(() =>
    import("@/components/editor/diff-viewer").then((m) => ({
      default: m.DiffViewer,
    })),
  ),
  settings: lazy(() =>
    import("@/components/settings/settings-tab").then((m) => ({
      default: m.SettingsTab,
    })),
  ),
  ports: lazy(() =>
    import("@/components/ports/port-forwarding-tab").then((m) => ({
      default: m.PortForwardingTab,
    })),
  ),
  extension: lazy(() =>
    import("@/components/extensions/extension-webview").then((m) => ({
      default: m.ExtensionWebview,
    })),
  ),
  "extension-webview": lazy(() =>
    import("@/components/extensions/extension-webview").then((m) => ({
      default: m.ExtensionWebview,
    })),
  ),
};

function LoadingFallback() {
  return (
    <div className="flex items-center justify-center h-full">
      <Loader2 className="size-6 animate-spin text-primary" />
    </div>
  );
}

export function TabContent() {
  const { tabs, activeTabId } = useTabStore();

  if (tabs.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-text-secondary">
        <p>No tab open. Use the + button or bottom nav to open one.</p>
      </div>
    );
  }

  return (
    <>
      {tabs.map((tab) => {
        const Component = TAB_COMPONENTS[tab.type];
        const isActive = tab.id === activeTabId;
        if (!Component) {
          return (
            <div key={tab.id} className={isActive ? "h-full w-full flex items-center justify-center text-muted-foreground" : "hidden"}>
              Unknown tab type: {tab.type}
            </div>
          );
        }
        return (
          <div
            key={tab.id}
            className={isActive ? "h-full w-full" : "hidden"}
          >
            <Suspense fallback={<LoadingFallback />}>
              <Component metadata={tab.metadata} tabId={tab.id} />
            </Suspense>
          </div>
        );
      })}
    </>
  );
}
