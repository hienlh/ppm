import { Suspense, lazy } from "react";
import { Loader2, Terminal, MessageSquare, GitBranch } from "lucide-react";
import { usePanelStore } from "@/stores/panel-store";
import { useProjectStore } from "@/stores/project-store";
import type { TabType } from "@/stores/tab-store";
import { TabBar } from "./tab-bar";
import { SplitDropOverlay } from "./split-drop-overlay";
import { cn } from "@/lib/utils";

const QUICK_OPEN_TABS: { type: TabType; label: string; icon: React.ElementType }[] = [
  { type: "terminal", label: "Terminal", icon: Terminal },
  { type: "chat", label: "AI Chat", icon: MessageSquare },
  { type: "git-graph", label: "Git Graph", icon: GitBranch },
];

const TAB_COMPONENTS: Record<TabType, React.LazyExoticComponent<React.ComponentType<{ metadata?: Record<string, unknown>; tabId?: string }>>> = {
  terminal: lazy(() => import("@/components/terminal/terminal-tab").then((m) => ({ default: m.TerminalTab }))),
  chat: lazy(() => import("@/components/chat/chat-tab").then((m) => ({ default: m.ChatTab }))),
  editor: lazy(() => import("@/components/editor/code-editor").then((m) => ({ default: m.CodeEditor }))),
  "git-graph": lazy(() => import("@/components/git/git-graph").then((m) => ({ default: m.GitGraph }))),
  "git-diff": lazy(() => import("@/components/editor/diff-viewer").then((m) => ({ default: m.DiffViewer }))),
  settings: lazy(() => import("@/components/settings/settings-tab").then((m) => ({ default: m.SettingsTab }))),
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
      onMouseDown={() => usePanelStore.getState().setFocusedPanel(panelId)}
    >
      <TabBar panelId={panelId} />

      <div className="flex-1 overflow-hidden relative">
        {panel.tabs.length === 0 ? (
          <EmptyPanel panelId={panelId} />
        ) : (
          panel.tabs.map((tab) => {
            const Component = TAB_COMPONENTS[tab.type];
            const isActive = tab.id === panel.activeTabId;
            return (
              <div key={tab.id} className={isActive ? "h-full w-full" : "hidden"}>
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
    const needsProject = type !== "settings";
    const metadata = needsProject && activeProject ? { projectName: activeProject.name } : undefined;
    usePanelStore.getState().openTab(
      { type, title: QUICK_OPEN_TABS.find((t) => t.type === type)?.label ?? type, metadata, projectId: activeProject?.name ?? null, closable: true },
      panelId,
    );
  }

  return (
    <div className="flex flex-col items-center justify-center h-full gap-4 text-text-secondary">
      <p className="text-sm">Open a tab to get started</p>
      <div className="flex flex-col md:flex-row flex-wrap justify-center gap-2">
        {QUICK_OPEN_TABS.map((opt) => {
          const Icon = opt.icon;
          return (
            <button
              key={opt.type}
              onClick={() => openTab(opt.type)}
              className="flex items-center gap-2 px-4 py-2 rounded-md border border-border bg-surface hover:bg-surface-elevated text-sm text-foreground transition-colors"
            >
              <Icon className="size-4" />
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
