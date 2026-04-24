import { Suspense, lazy, useCallback } from "react";
import { Loader2, Terminal, MessageSquare, FilePlus } from "lucide-react";
import { usePanelStore } from "@/stores/panel-store";
import { useProjectStore } from "@/stores/project-store";
import { useTabStore, type TabType } from "@/stores/tab-store";
import { SessionListPanel } from "@/components/chat/session-list-panel";
import type { SessionInfo } from "../../../types/chat";
import { TabBar } from "./tab-bar";
import { SplitDropOverlay } from "./split-drop-overlay";
import { cn } from "@/lib/utils";

const QUICK_OPEN_TABS: { type: TabType; label: string; icon: React.ElementType }[] = [
  { type: "terminal", label: "Terminal", icon: Terminal },
  { type: "chat", label: "AI Chat", icon: MessageSquare },
  { type: "editor", label: "New File", icon: FilePlus },
];

const TAB_COMPONENTS: Record<TabType, React.LazyExoticComponent<React.ComponentType<{ metadata?: Record<string, unknown>; tabId?: string }>>> = {
  terminal: lazy(() => import("@/components/terminal/terminal-tab").then((m) => ({ default: m.TerminalTab }))),
  chat: lazy(() => import("@/components/chat/chat-tab").then((m) => ({ default: m.ChatTab }))),
  editor: lazy(() => import("@/components/editor/code-editor").then((m) => ({ default: m.CodeEditor }))),
  database: lazy(() => import("@/components/database/database-viewer").then((m) => ({ default: m.DatabaseViewer }))),
  sqlite: lazy(() => import("@/components/sqlite/sqlite-viewer").then((m) => ({ default: m.SqliteViewer }))),
  postgres: lazy(() => import("@/components/postgres/postgres-viewer").then((m) => ({ default: m.PostgresViewer }))),
  "git-diff": lazy(() => import("@/components/editor/diff-viewer").then((m) => ({ default: m.DiffViewer }))),
  settings: lazy(() => import("@/components/settings/settings-tab").then((m) => ({ default: m.SettingsTab }))),
  ports: lazy(() => import("@/components/ports/port-forwarding-tab").then((m) => ({ default: m.PortForwardingTab }))),
  extension: lazy(() => import("@/components/extensions/extension-webview").then((m) => ({ default: m.ExtensionWebview }))),
  "extension-webview": lazy(() => import("@/components/extensions/extension-webview").then((m) => ({ default: m.ExtensionWebview }))),
  "conflict-editor": lazy(() => import("@/components/editor/conflict-editor").then((m) => ({ default: m.ConflictEditor }))),
};

interface EditorPanelProps {
  panelId: string;
  projectName: string;
}

export function EditorPanel({ panelId, projectName }: EditorPanelProps) {
  const panel = usePanelStore((s) => s.panels[panelId]);
  const isFocused = usePanelStore((s) => s.focusedPanelId === panelId);
  const panelCount = usePanelStore((s) => {
    const grid = s.currentProject === projectName ? s.grid : (s.projectGrids[projectName] ?? [[]]);
    return grid.flat().length;
  });

  if (!panel) return null;

  return (
    <div
      className={cn(
        "flex flex-col h-full overflow-hidden",
        panelCount > 1 && "border border-transparent",
        panelCount > 1 && isFocused && "border-primary/30",
      )}
      onMouseDown={() => { if (usePanelStore.getState().focusedPanelId !== panelId) usePanelStore.getState().setFocusedPanel(panelId); }}
    >
      <TabBar panelId={panelId} />

      <div className="flex-1 overflow-hidden relative" data-panel-drop-zone={panelId}>
        {panel.tabs.length === 0 ? (
          <EmptyPanel panelId={panelId} />
        ) : (
          panel.tabs.map((tab) => {
            const Component = TAB_COMPONENTS[tab.type];
            const isActive = tab.id === panel.activeTabId;
            if (!Component) {
              return (
                <div key={tab.id} className={isActive ? "absolute inset-0 flex items-center justify-center text-muted-foreground" : "hidden"}>
                  Unknown tab type: {tab.type}
                </div>
              );
            }
            return (
              <div key={tab.id} className="absolute inset-0" style={isActive ? undefined : { opacity: 0, pointerEvents: "none" }}>
                <Suspense fallback={<div className="flex items-center justify-center h-full"><Loader2 className="size-6 animate-spin text-primary" /></div>}>
                  <Component metadata={tab.metadata} tabId={tab.id} />
                </Suspense>
              </div>
            );
          })
        )}
        <SplitDropOverlay panelId={panelId} />
      </div>
    </div>
  );
}

function EmptyPanel({ panelId }: { panelId: string }) {
  const activeProject = useProjectStore((s) => s.activeProject);

  function openTab(type: TabType) {
    if (type === "editor") {
      useTabStore.getState().openNewFile();
      return;
    }
    const needsProject = type !== "settings";
    const metadata = needsProject && activeProject ? { projectName: activeProject.name } : undefined;
    usePanelStore.getState().openTab(
      { type, title: QUICK_OPEN_TABS.find((t) => t.type === type)?.label ?? type, metadata, projectId: activeProject?.name ?? null, closable: true },
      panelId,
    );
  }

  const openSession = useCallback((session: SessionInfo) => {
    usePanelStore.getState().openTab(
      {
        type: "chat",
        title: session.title || "Chat",
        projectId: activeProject?.name ?? null,
        metadata: { projectName: activeProject?.name, sessionId: session.id, providerId: session.providerId },
        closable: true,
      },
      panelId,
    );
  }, [activeProject?.name, panelId]);

  return (
    <div className="flex flex-col h-full overflow-y-auto text-text-secondary">
      <div className="flex flex-col items-center justify-center gap-6 px-4 flex-1">
        <p className="text-sm">Open a tab to get started</p>
        <div className="grid grid-cols-3 gap-2 w-full max-w-sm">
          {QUICK_OPEN_TABS.map((opt) => {
            const Icon = opt.icon;
            return (
              <button
                key={opt.type}
                onClick={() => openTab(opt.type)}
                className="flex flex-col items-center justify-center gap-1.5 px-2 py-3 rounded-md border border-border bg-surface hover:bg-surface-elevated active:bg-surface-elevated text-xs text-foreground transition-colors"
              >
                <Icon className="size-5" />
                {opt.label}
              </button>
            );
          })}
        </div>

        <SessionListPanel
          projectName={activeProject?.name}
          onSelectSession={openSession}
          className="w-full"
        />
      </div>
    </div>
  );
}
