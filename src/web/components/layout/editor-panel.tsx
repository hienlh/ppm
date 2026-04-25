import { useCallback } from "react";
import { Terminal, MessageSquare, FilePlus } from "lucide-react";
import { usePanelStore } from "@/stores/panel-store";
import { useProjectStore } from "@/stores/project-store";
import { useTabStore, type TabType } from "@/stores/tab-store";
import { SessionListPanel } from "@/components/chat/session-list-panel";
import type { SessionInfo } from "../../../types/chat";
import { TabBar } from "./tab-bar";
import { SplitDropOverlay } from "./split-drop-overlay";
import { registerPanelSlot } from "./tab-pool";
import { cn } from "@/lib/utils";

const QUICK_OPEN_TABS: { type: TabType; label: string; icon: React.ElementType }[] = [
  { type: "terminal", label: "Terminal", icon: Terminal },
  { type: "chat", label: "AI Chat", icon: MessageSquare },
  { type: "editor", label: "New File", icon: FilePlus },
];

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

  // Register this panel's content area as a portal slot for TabPool.
  // Callback ref fires synchronously: with element on mount, with null on unmount.
  // No separate useEffect cleanup needed — callback ref handles both cases.
  // (A useEffect cleanup would fire async AFTER a new EditorPanel with the same
  // panelId already re-registered, deregistering the new slot and causing blank panels.)
  const slotCallbackRef = useCallback((el: HTMLDivElement | null) => {
    registerPanelSlot(panelId, el);
  }, [panelId]);

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
        {panel.tabs.length === 0 && <EmptyPanel panelId={panelId} />}
        {/* Always render the slot so TabPool can portal into it immediately.
            Hidden when empty to let EmptyPanel show through. */}
        <div ref={slotCallbackRef} className="absolute inset-0" style={panel.tabs.length === 0 ? { display: "none" } : undefined} />
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
