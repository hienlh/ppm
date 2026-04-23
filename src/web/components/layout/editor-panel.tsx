import { Suspense, lazy, useEffect, useState, useCallback } from "react";
import { ChevronDown, ChevronUp, Loader2, Terminal, MessageSquare, FilePlus, Pin, PinOff } from "lucide-react";
import { usePanelStore } from "@/stores/panel-store";
import { useProjectStore } from "@/stores/project-store";
import { useTabStore, type TabType } from "@/stores/tab-store";
import { api, projectUrl } from "@/lib/api-client";
import { useProjectTags, TagChipBar } from "@/components/chat/tag-filter-chips";
import { SessionContextMenu } from "@/components/chat/session-context-menu";
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

function formatRelativeDate(iso: string): string {
  try {
    const date = new Date(iso);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMin = Math.floor(diffMs / 60_000);
    if (diffMin < 1) return "Just now";
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    const diffDay = Math.floor(diffHr / 24);
    if (diffDay < 7) return `${diffDay}d ago`;
    return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  } catch {
    return "";
  }
}

const MAX_RECENT_SESSIONS = 5;
const FETCH_SESSIONS_LIMIT = 20;

function EmptyPanel({ panelId }: { panelId: string }) {
  const activeProject = useProjectStore((s) => s.activeProject);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [selectedTagId, setSelectedTagId] = useState<number | null>(null);
  const { projectTags, tagCounts, loadTags } = useProjectTags(activeProject?.name);

  const loadSessions = useCallback(async () => {
    if (!activeProject?.name) return;
    setLoadingSessions(true);
    try {
      const data = await api.get<{ sessions: SessionInfo[]; hasMore: boolean }>(`${projectUrl(activeProject.name)}/chat/sessions?limit=${FETCH_SESSIONS_LIMIT}`);
      setSessions(data.sessions.slice(0, FETCH_SESSIONS_LIMIT));
    } catch {
      // silently ignore — empty state still functional without sessions
    } finally {
      setLoadingSessions(false);
    }
  }, [activeProject?.name]);

  useEffect(() => { loadSessions(); }, [loadSessions]);

  const togglePin = useCallback(async (e: React.MouseEvent, session: SessionInfo) => {
    e.stopPropagation();
    if (!activeProject?.name) return;
    const url = `${projectUrl(activeProject.name)}/chat/sessions/${session.id}/pin`;
    try {
      if (session.pinned) {
        await api.del(url);
      } else {
        await api.put(url);
      }
      setSessions((prev) => {
        const updated = prev.map((s) => s.id === session.id ? { ...s, pinned: !s.pinned } : s);
        return updated.sort((a, b) => {
          if (a.pinned && !b.pinned) return -1;
          if (!a.pinned && b.pinned) return 1;
          return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
        });
      });
    } catch {
      // silently ignore
    }
  }, [activeProject?.name]);

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

  function openSession(session: SessionInfo) {
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
  }

  const handleTagChanged = useCallback((sid: string, tag: { id: number; name: string; color: string } | null) => {
    setSessions((prev) => prev.map((s) => s.id === sid ? { ...s, tag } : s));
    loadTags();
  }, [loadTags]);

  const filtered = selectedTagId !== null ? sessions.filter((s) => s.tag?.id === selectedTagId) : sessions;
  const pinnedSessions = filtered.filter((s) => s.pinned);
  const allRecentSessions = filtered.filter((s) => !s.pinned);
  const recentSessions = showAll ? allRecentSessions : allRecentSessions.slice(0, MAX_RECENT_SESSIONS);
  const hasMore = allRecentSessions.length > MAX_RECENT_SESSIONS;

  function renderSessionRow(session: SessionInfo) {
    return (
      <SessionContextMenu
        key={session.id}
        session={session}
        projectName={activeProject!.name}
        projectTags={projectTags}
        onTogglePin={togglePin}
        onTagChanged={handleTagChanged}
      >
        <button
          onClick={() => openSession(session)}
          className="group flex items-center gap-2.5 w-full px-3 py-2.5 text-left hover:bg-surface-elevated active:bg-surface-elevated transition-colors border-b border-border/50 last:border-0"
        >
          <MessageSquare className="size-3.5 shrink-0 text-text-subtle" />
          {session.tag && (
            <span className="size-2 rounded-full shrink-0" style={{ backgroundColor: session.tag.color }} title={session.tag.name} />
          )}
          <span className="flex-1 min-w-0 text-xs font-medium truncate text-text-primary">
            {session.title || "Untitled"}
          </span>
          {session.updatedAt && (
            <span className="text-[10px] text-text-subtle shrink-0">
              {formatRelativeDate(session.updatedAt)}
            </span>
          )}
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => togglePin(e, session)}
            className={`p-1 rounded transition-colors shrink-0 ${
              session.pinned
                ? "text-primary hover:text-primary/70"
                : "text-text-subtle can-hover:opacity-0 can-hover:group-hover:opacity-100 hover:text-text-primary"
            }`}
            aria-label={session.pinned ? "Unpin session" : "Pin session"}
          >
            {session.pinned ? <PinOff className="size-3" /> : <Pin className="size-3" />}
        </span>
        </button>
      </SessionContextMenu>
    );
  }

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

        {activeProject && !loadingSessions && sessions.length > 0 && (
          <div className="w-full max-w-sm">
            <TagChipBar projectTags={projectTags} tagCounts={tagCounts} totalCount={sessions.length} selectedTagId={selectedTagId} onSelect={setSelectedTagId} />
          </div>
        )}

        {activeProject && !loadingSessions && pinnedSessions.length > 0 && (
          <div className="flex flex-col gap-2 w-full max-w-sm">
            <p className="text-xs text-text-subtle text-center">Pinned</p>
            <div className="w-full rounded-md border border-border bg-surface overflow-hidden">
              {pinnedSessions.map(renderSessionRow)}
            </div>
          </div>
        )}

        {activeProject && !loadingSessions && recentSessions.length > 0 && (
          <div className="flex flex-col gap-2 w-full max-w-sm">
            <p className="text-xs text-text-subtle text-center">Recent chats</p>
            <div className="w-full rounded-md border border-border bg-surface overflow-hidden">
              {recentSessions.map(renderSessionRow)}
            </div>
            {hasMore && (
              <button
                onClick={() => setShowAll(!showAll)}
                className="flex items-center justify-center gap-1 text-[11px] text-text-subtle hover:text-text-primary transition-colors py-1"
              >
                {showAll ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
                {showAll ? "Show less" : `Show more (${allRecentSessions.length - MAX_RECENT_SESSIONS})`}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
