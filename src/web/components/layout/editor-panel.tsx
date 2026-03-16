import { Suspense, lazy } from "react";
import { Loader2 } from "lucide-react";
import { usePanelStore } from "@/stores/panel-store";
import type { TabType } from "@/stores/tab-store";
import { TabBar } from "./tab-bar";
import { SplitDropOverlay } from "./split-drop-overlay";
import { cn } from "@/lib/utils";

const TAB_COMPONENTS: Record<TabType, React.LazyExoticComponent<React.ComponentType<{ metadata?: Record<string, unknown>; tabId?: string }>>> = {
  projects: lazy(() => import("@/components/projects/project-list").then((m) => ({ default: m.ProjectList }))),
  terminal: lazy(() => import("@/components/terminal/terminal-tab").then((m) => ({ default: m.TerminalTab }))),
  chat: lazy(() => import("@/components/chat/chat-tab").then((m) => ({ default: m.ChatTab }))),
  editor: lazy(() => import("@/components/editor/code-editor").then((m) => ({ default: m.CodeEditor }))),
  "git-graph": lazy(() => import("@/components/git/git-graph").then((m) => ({ default: m.GitGraph }))),
  "git-status": lazy(() => import("@/components/git/git-status-panel").then((m) => ({ default: m.GitStatusPanel }))),
  "git-diff": lazy(() => import("@/components/editor/diff-viewer").then((m) => ({ default: m.DiffViewer }))),
  settings: lazy(() => import("@/components/settings/settings-tab").then((m) => ({ default: m.SettingsTab }))),
};

interface EditorPanelProps {
  panelId: string;
}

export function EditorPanel({ panelId }: EditorPanelProps) {
  const panel = usePanelStore((s) => s.panels[panelId]);
  const isFocused = usePanelStore((s) => s.focusedPanelId === panelId);
  const panelCount = usePanelStore((s) => Object.keys(s.panels).length);

  if (!panel) return null;

  return (
    <div
      className={cn(
        "flex flex-col h-full overflow-hidden",
        panelCount > 1 && "border border-transparent",
        panelCount > 1 && isFocused && "border-primary/30",
      )}
      onClick={() => usePanelStore.getState().setFocusedPanel(panelId)}
    >
      <TabBar panelId={panelId} />

      <div className="flex-1 overflow-hidden relative">
        {panel.tabs.length === 0 ? (
          <div className="flex items-center justify-center h-full text-text-secondary text-sm">
            Drop a tab here
          </div>
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
