import { Suspense, lazy } from "react";
import { useShallow } from "zustand/react/shallow";
import { useTabStore, type TabType } from "@/stores/tab-store";
import { Loader2 } from "@/lib/icons";

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
    import("@/components/database/table/table-tab").then((m) => ({
      default: m.TableTab,
    })),
  ),
  "db-structure": lazy(() =>
    import("@/components/database/structure/structure-tab").then((m) => ({
      default: m.StructureTab,
    })),
  ),
  "db-sql": lazy(() =>
    import("@/components/database/sql-object/sql-object-tab").then((m) => ({
      default: m.SqlObjectTab,
    })),
  ),
  "db-query": lazy(() =>
    import("@/components/database/query/query-tab").then((m) => ({
      default: m.QueryTab,
    })),
  ),
  "db-impexp": lazy(() =>
    import("@/components/database/impexp/impexp-tab").then((m) => ({
      default: m.ImpExpTab,
    })),
  ),
  "db-connection": lazy(() =>
    import("@/components/database/connection-form/connection-form-tab").then((m) => ({
      default: m.ConnectionFormTab,
    })),
  ),
  sqlite: lazy(() =>
    import("@/components/sqlite/sqlite-viewer").then((m) => ({
      default: m.SqliteViewer,
    })),
  ),
  "git-diff": lazy(() =>
    import("@/components/editor/diff-viewer").then((m) => ({
      default: m.DiffViewer,
    })),
  ),
  "branch-review": lazy(() =>
    import("@/components/branch-review/branch-review-tab").then((m) => ({
      default: m.BranchReviewTab,
    })),
  ),
  "session-review": lazy(() =>
    import("@/components/session-review/session-review-tab").then((m) => ({
      default: m.SessionReviewTab,
    })),
  ),
  "git-review": lazy(() =>
    import("@/components/git-review/git-review-tab").then((m) => ({
      default: m.GitReviewTab,
    })),
  ),
  settings: lazy(() =>
    import("@/components/settings/settings-tab").then((m) => ({
      default: m.SettingsTab,
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
  "conflict-editor": lazy(() =>
    import("@/components/editor/conflict-editor").then((m) => ({
      default: m.ConflictEditor,
    })),
  ),
  android: lazy(() =>
    import("@/components/android/android-tab").then((m) => ({
      default: m.AndroidTab,
    })),
  ),
  "system-monitor": lazy(() =>
    import("@/components/system/system-monitor-tab").then((m) => ({
      default: m.SystemMonitorTab,
    })),
  ),
  "git-log": lazy(() =>
    import("@/components/git/git-log-panel").then((m) => ({
      default: m.GitLogPanel,
    })),
  ),
  "ai-resource": lazy(() =>
    import("@/components/ai-resources/ai-resource-editor").then((m) => ({
      default: m.AiResourceEditor,
    })),
  ),
  group: lazy(() =>
    import("@/components/group-chat/group-chat-tab").then((m) => ({
      default: m.GroupChatTab,
    })),
  ),
  problems: lazy(() =>
    import("@/components/problems/problems-panel").then((m) => ({
      default: m.ProblemsPanel,
    })),
  ),
  design: lazy(() =>
    import("@/components/design/design-tab").then((m) => ({
      default: m.DesignTab,
    })),
  ),
  "web-preview": lazy(() =>
    import("@/components/web-preview/web-preview-tab").then((m) => ({
      default: m.WebPreviewTab,
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
  const { tabs, activeTabId } = useTabStore(useShallow((s) => ({ tabs: s.tabs, activeTabId: s.activeTabId })));

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
