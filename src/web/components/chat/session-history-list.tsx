import { Loader2, RefreshCw, Search, Pencil, Check, X, Pin, PinOff, Trash2, Bot, Tags, CalendarX2, MessageSquare, BotMessageSquare } from "lucide-react";
import { SidebarHeader } from "@/components/ui/sidebar-header";
import { cn } from "@/lib/utils";
import { useNotificationStore, notificationTint } from "@/stores/notification-store";
import { useTabStore } from "@/stores/tab-store";
import { formatRelativeDate } from "@/lib/format-date";
import { TagSettingsSection } from "@/components/settings/tag-settings-section";
import { SessionContextMenu } from "./session-context-menu";
import { ProviderBadge } from "./provider-selector";
import { SearchSnippet } from "./search-snippet";
import { useSessionHistory } from "@/hooks/use-session-history";
import { useChatSearch } from "@/hooks/use-chat-search";
import type { SessionInfo, ChatSearchResult } from "../../../types/chat";

/** Sidebar search-results list (unified title + content matches with snippets). */
function SearchResultsList({ search, onOpen }: { search: ReturnType<typeof useChatSearch>; onOpen: (r: ChatSearchResult) => void }) {
  return (
    <div>
      {search.indexing.running && (
        <div className="flex items-center gap-1 px-3 py-1 text-[10px] text-text-subtle">
          <Loader2 className="size-2.5 animate-spin" /> Indexing {search.indexing.indexed}/{search.indexing.total}…
        </div>
      )}
      {search.loading && search.results.length === 0 ? (
        <div className="flex items-center justify-center py-3"><Loader2 className="size-3.5 animate-spin text-text-subtle" /></div>
      ) : search.results.length === 0 ? (
        <div className="flex items-center justify-center py-3 text-[11px] text-text-subtle">
          {search.indexing.running ? "No matches yet — indexing…" : "No matches"}
        </div>
      ) : (
        search.results.map((r) => (
          <button
            key={r.sessionId}
            onClick={() => onOpen(r)}
            className="group relative flex w-full items-center gap-2 px-2 py-1.5 text-left hover:bg-surface-elevated transition-colors"
          >
            <MessageSquare className="size-4 shrink-0 text-text-subtle" />
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5">
                <span className="truncate text-[13px] font-medium">{r.title || "Untitled"}</span>
              </span>
              {r.matchedIn === "content" && r.snippet && (
                <SearchSnippet snippet={r.snippet} className="block text-[11px] text-text-subtle line-clamp-2" />
              )}
            </span>
          </button>
        ))
      )}
    </div>
  );
}

interface SessionHistoryListProps {
  projectName: string;
  variant: "bar" | "sidebar";
  sessionId?: string | null;
  onSelectSession?: (session: SessionInfo) => void;
  className?: string;
}

/**
 * Shared chat-history list UI used by both the in-chat toolbar bar and the
 * sidebar History tab. Behavior lives in `useSessionHistory`; `variant` only
 * changes container sizing/density — rows + handlers are identical.
 */
export function SessionHistoryList({ projectName, variant, sessionId, onSelectSession, className }: SessionHistoryListProps) {
  const h = useSessionHistory({
    projectName,
    sessionId,
    onSelectSession,
    enableKeyboardShortcuts: variant === "bar",
  });
  const notifications = useNotificationStore((s) => s.notifications);
  const openTab = useTabStore((s) => s.openTab);

  const isSidebar = variant === "sidebar";
  // Content-aware unified search is a sidebar affordance; the bar keeps its
  // lightweight title-only filter.
  const contentSearch = useChatSearch(projectName, isSidebar ? h.searchQuery : "");
  const showSearch = isSidebar && h.searchQuery.trim().length > 0;

  function openResult(r: ChatSearchResult) {
    openTab({
      type: "chat",
      title: r.title || "Chat",
      projectId: projectName,
      metadata: { projectName, sessionId: r.sessionId, providerId: r.providerId },
      closable: true,
    });
  }

  return (
    <div className={cn(isSidebar ? "flex flex-col h-full min-h-0" : "border-t border-border/30 bg-surface", className)}>
      {/* Header (sidebar only — the bar variant already sits under its own toolbar) */}
      {isSidebar && <SidebarHeader icon={BotMessageSquare} title="Chat History" />}

      {/* Search + bulk delete + refresh */}
      <div className="flex items-center gap-1 px-2 py-2 shrink-0">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-text-subtle" />
          <input
            type="text"
            value={h.searchQuery}
            onChange={(e) => h.setSearchQuery(e.target.value)}
            placeholder="Filter sessions…"
            className="w-full rounded-md border border-border bg-surface-elevated py-1.5 pl-7 pr-2 text-xs outline-none focus:border-primary/50"
          />
        </div>
        <button
          onClick={h.bulkDelete}
          className="flex size-6 items-center justify-center rounded text-text-subtle hover:bg-surface-elevated hover:text-error"
          title="Delete old sessions..."
        >
          <CalendarX2 className="size-3.5" />
        </button>
        <button
          onClick={() => h.load(h.searchQuery || undefined)}
          disabled={h.loading}
          className="flex size-6 items-center justify-center rounded text-text-subtle hover:bg-surface-elevated hover:text-foreground disabled:opacity-50"
          title="Refresh"
        >
          <RefreshCw className={cn("size-3.5", h.loading && "animate-spin")} />
        </button>
      </div>

      {/* Tag filter chips */}
      {h.projectTags.length > 0 && (
        <div className="flex items-center gap-1 px-2 py-2 overflow-x-auto scrollbar-none shrink-0">
          <button
            onClick={() => h.setSelectedTagId(null)}
            className={cn(
              "shrink-0 rounded-full border px-2 py-0.5 text-[11px] transition-colors",
              h.selectedTagId === null
                ? "border-primary/40 bg-primary/10 text-primary"
                : "border-border text-text-subtle hover:bg-surface-elevated",
            )}
          >All ({h.sessions.length})</button>
          {h.projectTags.map((tag) => (
            <button
              key={tag.id}
              onClick={() => h.setSelectedTagId(h.selectedTagId === tag.id ? null : tag.id)}
              className={cn(
                "shrink-0 flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] transition-colors",
                h.selectedTagId === tag.id
                  ? "border-current"
                  : "border-border text-text-subtle hover:bg-surface-elevated",
              )}
              style={h.selectedTagId === tag.id ? { backgroundColor: tag.color + "20", color: tag.color, borderColor: tag.color } : undefined}
            >
              <span className="size-2 rounded-full shrink-0" style={{ backgroundColor: tag.color }} />
              {tag.name} ({h.tagCounts[tag.id] ?? 0})
            </button>
          ))}
          <button
            onClick={() => h.setShowTagSettings(!h.showTagSettings)}
            className={cn(
              "shrink-0 flex size-5 items-center justify-center rounded-full transition-colors",
              h.showTagSettings ? "text-primary bg-primary/10" : "text-text-subtle hover:bg-surface-elevated",
            )}
            title="Manage tags"
          >
            <Tags className="size-3" />
          </button>
        </div>
      )}

      {/* Tag management panel (inline) */}
      {h.showTagSettings && (
        <div className="border-b border-border/30 px-2 py-2 max-h-[180px] overflow-y-auto bg-surface-elevated/50 shrink-0">
          <TagSettingsSection projectName={projectName} onTagsChanged={h.loadTags} />
        </div>
      )}

      <div className={isSidebar ? "flex-1 overflow-y-auto min-h-0" : "max-h-[200px] overflow-y-auto"}>
        {showSearch ? (
          <SearchResultsList search={contentSearch} onOpen={openResult} />
        ) : h.loading && h.sessions.length === 0 ? (
          <div className="flex items-center justify-center py-3">
            <Loader2 className="size-3.5 animate-spin text-text-subtle" />
          </div>
        ) : h.filteredSessions.length === 0 ? (
          <div className="flex items-center justify-center py-3 text-[11px] text-text-subtle">
            {h.searchQuery ? "No matching sessions" : "No sessions yet"}
          </div>
        ) : (
          <>
            {h.filteredSessions.map((session) => {
              const notif = notifications.get(session.id);
              const isUnread = !!notif;
              return (
                <SessionContextMenu
                  key={session.id}
                  session={session}
                  projectName={projectName}
                  projectTags={h.projectTags}
                  onTogglePin={h.togglePin}
                  onStartEditing={h.startEditing}
                  onDeleteSession={h.deleteSession}
                  onTagChanged={h.handleTagChanged}
                >
                  <div
                    className={cn(
                      "group relative flex w-full items-center gap-2 px-2 py-1.5 text-left transition-colors",
                      sessionId === session.id
                        ? "bg-accent-wash text-foreground shadow-[inset_2px_0_0_var(--accent)]"
                        : "hover:bg-surface-elevated",
                      isUnread && notificationTint(notif.type),
                      !isUnread && sessionId !== session.id && "text-text-secondary",
                    )}
                  >
                    <ProviderBadge providerId={session.providerId} />
                    {session.tag && (
                      <span className="size-2 rounded-full shrink-0" style={{ backgroundColor: session.tag.color }} title={session.tag.name} />
                    )}
                    {h.editingId === session.id ? (
                      <form
                        className="flex items-center gap-1 flex-1 min-w-0"
                        onSubmit={(e) => { e.preventDefault(); h.saveTitle(); }}
                      >
                        <input
                          ref={h.editInputRef}
                          value={h.editingTitle}
                          onChange={(e) => h.setEditingTitle(e.target.value)}
                          onBlur={h.saveTitle}
                          onKeyDown={(e) => { if (e.key === "Escape") h.cancelEditing(); }}
                          className="flex-1 min-w-0 bg-surface-elevated text-xs text-text-primary px-1.5 py-0.5 rounded border border-border outline-none focus:border-primary/50"
                          autoFocus
                        />
                        <button type="submit" className="p-0.5 text-success hover:text-success/80" onClick={(e) => e.stopPropagation()}>
                          <Check className="size-3" />
                        </button>
                        <button type="button" className="p-0.5 text-text-subtle hover:text-text-secondary" onClick={(e) => { e.stopPropagation(); h.cancelEditing(); }}>
                          <X className="size-3" />
                        </button>
                      </form>
                    ) : (
                      <>
                        <span className="min-w-0 flex-1">
                          <button
                            onClick={() => h.openSession(session)}
                            className="w-full min-w-0 text-left"
                          >
                            <span className="flex items-center gap-1">
                              {session.title?.startsWith("[PPM]") && (
                                <Bot className="size-3.5 text-muted-foreground shrink-0" />
                              )}
                              <span className={cn("truncate text-[13px]", isUnread ? "font-semibold" : "font-medium")}>
                                {session.title?.startsWith("[PPM]")
                                  ? session.title.slice(7)
                                  : session.title || "Untitled"}
                              </span>
                            </span>
                            {session.updatedAt && (
                              <span className="block text-[11px] text-text-subtle">{formatRelativeDate(session.updatedAt)}</span>
                            )}
                          </button>
                        </span>
                        <button
                          onClick={(e) => h.togglePin(e, session)}
                          className={cn(
                            "p-0.5 rounded transition-all",
                            session.pinned
                              ? "text-primary hover:text-primary/70"
                              : "text-text-subtle hover:text-text-secondary can-hover:opacity-0 can-hover:group-hover:opacity-100",
                          )}
                          title={session.pinned ? "Unpin session" : "Pin session"}
                        >
                          {session.pinned ? <PinOff className="size-3" /> : <Pin className="size-3" />}
                        </button>
                        <span className="flex items-center shrink-0 can-hover:hidden can-hover:group-hover:flex">
                          <button
                            onClick={(e) => h.startEditing(session, e)}
                            className="p-0.5 rounded text-text-subtle hover:text-text-secondary transition-colors"
                            title="Rename session"
                          >
                            <Pencil className="size-3" />
                          </button>
                          <button
                            onClick={(e) => h.deleteSession(e, session)}
                            className="p-0.5 rounded text-text-subtle hover:text-error hover:bg-error/20 transition-colors"
                            title="Delete session"
                          >
                            <Trash2 className="size-3" />
                          </button>
                        </span>
                      </>
                    )}
                  </div>
                </SessionContextMenu>
              );
            })}
            {h.hasMore && (
              <button
                onClick={h.loadMore}
                disabled={h.loadingMore}
                className="flex items-center justify-center gap-1 w-full py-1.5 text-[11px] text-text-subtle hover:text-text-secondary hover:bg-surface-elevated transition-colors"
              >
                {h.loadingMore ? <Loader2 className="size-3 animate-spin" /> : null}
                {h.loadingMore ? "Loading..." : "Load more"}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
