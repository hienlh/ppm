import { Fragment, useMemo, useState, type ReactNode } from "react";
import { Loader2, RefreshCw, Search, Pencil, Check, X, Pin, PinOff, Trash2, Bot, Tags, CalendarX2, BotMessageSquare, ChevronDown, ChevronRight, GitBranch, FolderTree, List, CircleX } from "@/lib/icons";
import { SidebarHeader } from "@/components/ui/sidebar-header";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useNotificationStore, notificationTint } from "@/stores/notification-store";
import { openSessionInItsTab } from "@/lib/design/open-design-tab";
import { formatRelativeDate } from "@/lib/format-date";
import { TagSettingsSection } from "@/components/settings/tag-settings-section";
import { SessionContextMenu } from "./session-context-menu";
import { ProviderBadge } from "./provider-selector";
import { SpawnedSessionBadge } from "./spawned-session-badge";
import { SearchSnippet } from "./search-snippet";
import { useSessionHistory } from "@/hooks/use-session-history";
import { useChatSearch } from "@/hooks/use-chat-search";
import { SessionListSyncIndicator } from "./session-list-sync-indicator";
import { useProjectRef } from "@/stores/session-list-sync-triggers";
import { useStreamingStore } from "@/stores/streaming-store";
import { useSettingsStore } from "@/stores/settings-store";
import { openLinkedSession } from "@/lib/session-collab-client";
import { buildSessionTree, descendantsOf, type SessionTreeNode, type SessionTreeRoot } from "@/lib/session-tree";
import { useSpecList } from "@/hooks/use-spec";
import { orderTaskChats, specBar, specProgress, taskCellBySession, type SpecBarCell } from "@/lib/spec-family";
import type { SpecSummary } from "../../../shared/spec-types";
import type { SessionInfo, ChatSearchResult } from "../../../types/chat";

/** Left padding of a row `depth` levels under a top-level chat. */
const indent = (depth: number) => 8 + depth * 16;

/** Task chats listed under an open spec before "Show N more". */
const TASK_CHATS_SHOWN = 7;
/** Task chats line up under the spec chat's title, past its provider icon. */
const SPEC_KIDS_INDENT = 24;
const BAR_CELL: Record<SpecBarCell, string> = { done: "bg-success", running: "bg-info", failed: "bg-error", todo: "bg-border" };

function TaskMark({ cell, running }: { cell: SpecBarCell | undefined; running: boolean }) {
  if (running || cell === "running") return <Loader2 className="size-3.5 shrink-0 animate-spin text-info" aria-label="Running" />;
  if (cell === "failed") return <CircleX className="size-3.5 shrink-0 text-error" aria-label="Failed" />;
  if (cell === "done") return <Check className="size-3.5 shrink-0 text-success" aria-label="Done" />;
  return <span className="size-3.5 shrink-0" />;
}

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
            <ProviderBadge providerId={r.providerId} />
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
  /** Fired after a session opens — lets the mobile drawer dismiss itself. */
  onNavigate?: () => void;
  className?: string;
}

/**
 * Shared chat-history list UI used by both the in-chat toolbar bar and the
 * sidebar History tab. Behavior lives in `useSessionHistory`; `variant` only
 * changes container sizing/density — rows + handlers are identical.
 */
export function SessionHistoryList({ projectName, variant, sessionId, onSelectSession, onNavigate, className }: SessionHistoryListProps) {
  const h = useSessionHistory({
    projectName,
    sessionId,
    onSelectSession,
    enableKeyboardShortcuts: variant === "bar",
  });
  const notifications = useNotificationStore((s) => s.notifications);
  const streaming = useStreamingStore((s) => s.sessions);
  const viewMode = useSettingsStore((s) => s.chatHistoryViewMode);
  const setViewMode = useSettingsStore((s) => s.setChatHistoryViewMode);
  const tree = useMemo(() => buildSessionTree(h.filteredSessions), [h.filteredSessions]);
  /** Families the user opened or closed; the rest follow the open chat. */
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  /** Spec families showing every task chat rather than the first few. */
  const [showAll, setShowAll] = useState<Record<string, boolean>>({});
  const { specs } = useSpecList(projectName);
  const specByChat = useMemo(
    () => new Map((specs ?? []).filter((s) => s.sessionId && s.tasks.length > 0).map((s) => [s.sessionId!, s])),
    [specs],
  );

  const project = useProjectRef(projectName);
  const isSidebar = variant === "sidebar";
  // Content-aware unified search is a sidebar affordance; the bar keeps its
  // lightweight title-only filter.
  const contentSearch = useChatSearch(projectName, isSidebar ? h.searchQuery : "");
  const showSearch = isSidebar && h.searchQuery.trim().length > 0;

  function openResult(r: ChatSearchResult) {
    openSessionInItsTab(
      { id: r.sessionId, providerId: r.providerId, title: r.title ?? undefined, designSlug: r.designSlug },
      projectName,
    );
    onNavigate?.();
  }

  function openSession(session: SessionInfo) {
    h.openSession(session);
    onNavigate?.();
  }

  /** `meta` replaces the time line under the title; `trailing` goes at the row's end. */
  function renderRow(session: SessionInfo, depth: number, opts?: { meta?: ReactNode; trailing?: ReactNode }) {
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
          style={depth > 0 ? { paddingLeft: indent(depth) } : undefined}
        >
          <ProviderBadge providerId={session.providerId} />
          {session.tag && (
            <span className="size-2 rounded-full shrink-0" style={{ backgroundColor: session.tag.color }} title={session.tag.name} />
          )}
          {/* Under its creator the mark says nothing the tree does not. */}
          {depth === 0 && <SpawnedSessionBadge session={session} projectName={projectName} />}
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
                  onClick={() => openSession(session)}
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
                  {opts?.meta ?? (session.updatedAt && (
                    <span className="block text-[11px] text-text-subtle">{formatRelativeDate(session.updatedAt)}</span>
                  ))}
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
              {opts?.trailing}
            </>
          )}
        </div>
      </SessionContextMenu>
    );
  }

  /** The family below a row, collapsed until asked for — or while it holds the open chat. */
  function renderChildren(parentId: string, children: SessionTreeNode[], depth: number) {
    if (children.length === 0) return null;
    const all = descendantsOf(children);
    const open = expanded[parentId] ?? all.some((x) => x.id === sessionId);
    const running = all.filter((x) => streaming.has(x.id)).length;
    const unread = all.filter((x) => notifications.has(x.id)).length;
    const Chevron = open ? ChevronDown : ChevronRight;
    return (
      <Fragment key={`${parentId}:children`}>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setExpanded((prev) => ({ ...prev, [parentId]: !open }))}
          className="flex w-full items-center gap-1 py-1 pr-2 text-left text-[11px] text-text-subtle hover:bg-surface-elevated hover:text-text-secondary transition-colors"
          style={{ paddingLeft: indent(depth) }}
        >
          <Chevron className="size-3 shrink-0" />
          <span>{all.length} sub-chat{all.length === 1 ? "" : "s"}</span>
          {running > 0 && <span className="text-info">· {running} running</span>}
          {unread > 0 && <span className="font-semibold text-foreground">· {unread} unread</span>}
        </button>
        {open && children.map((n) => (
          <Fragment key={n.session.id}>
            {renderRow(n.session, depth)}
            {renderChildren(n.session.id, n.children, depth + 1)}
          </Fragment>
        ))}
      </Fragment>
    );
  }

  /** A task chat under its spec: one line, with the task's state in front. */
  function renderTaskRow(session: SessionInfo, cell: SpecBarCell | undefined) {
    const notif = notifications.get(session.id);
    const active = sessionId === session.id;
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
        <button
          type="button"
          onClick={() => openSession(session)}
          className={cn(
            "flex h-[26px] max-md:h-11 w-full items-center gap-2 rounded-md pr-2 pl-1.5 text-left text-xs transition-colors",
            active ? "bg-accent-wash text-foreground shadow-[inset_2px_0_0_var(--accent)]" : "hover:bg-surface-elevated",
            notif ? cn(notificationTint(notif.type), "font-semibold") : !active && (cell === "done" ? "text-text-subtle" : "text-text-secondary"),
          )}
        >
          <TaskMark cell={cell} running={streaming.has(session.id)} />
          <span className="min-w-0 flex-1 truncate">{session.title || "Untitled"}</span>
          {session.updatedAt && <span className="shrink-0 text-[11px] font-normal text-text-subtle">{formatRelativeDate(session.updatedAt)}</span>}
        </button>
      </SessionContextMenu>
    );
  }

  /** A spec's chat with its progress, and its task chats below it: running and failed first. */
  function renderSpecFamily(session: SessionInfo, children: SessionTreeNode[], spec: SpecSummary) {
    const all = descendantsOf(children);
    const open = expanded[session.id] ?? all.some((x) => x.id === sessionId);
    const unread = all.filter((x) => notifications.has(x.id)).length;
    const p = specProgress(spec);
    const cells = taskCellBySession(spec);
    const ordered = orderTaskChats(children, cells);
    // The open chat is never hidden behind "Show more".
    const everything = showAll[session.id] || ordered.findIndex((n) => n.session.id === sessionId) >= TASK_CHATS_SHOWN;
    const shown = everything ? ordered : ordered.slice(0, TASK_CHATS_SHOWN);
    const Chevron = open ? ChevronDown : ChevronRight;
    const meta = (
      <>
        <span className="mt-1.5 flex h-1 gap-0.5 overflow-hidden rounded-full" aria-hidden>
          {specBar(spec).map((c, i) => <i key={i} className={cn("min-w-0 flex-1", BAR_CELL[c])} />)}
        </span>
        <span className="mt-1 flex items-center gap-1.5 whitespace-nowrap text-[11px] text-text-subtle">
          <span className="tabular-nums text-text-secondary">{p.done}/{p.total} done</span>
          {p.running > 0 && <span className="text-info">· {p.running} running</span>}
          {p.failed > 0 && <span className="text-error">· {p.failed} failed</span>}
          {unread > 0 && <span className="font-semibold text-foreground">· {unread} unread</span>}
          {session.updatedAt && <span className="ml-auto truncate">{formatRelativeDate(session.updatedAt)}</span>}
        </span>
      </>
    );
    const toggle = (
      <button
        type="button"
        aria-expanded={open}
        aria-label={open ? "Hide task chats" : `Show ${all.length} task chat${all.length === 1 ? "" : "s"}`}
        onClick={() => setExpanded((prev) => ({ ...prev, [session.id]: !open }))}
        className="grid size-6 max-md:size-11 shrink-0 place-items-center self-start rounded text-text-subtle hover:bg-surface-elevated hover:text-text-secondary"
      >
        <Chevron className="size-3.5" />
      </button>
    );
    return (
      <Fragment key={session.id}>
        {renderRow(session, 0, { meta, trailing: toggle })}
        {open && (
          <div className="pt-0.5 pb-1.5 pr-1" style={{ paddingLeft: SPEC_KIDS_INDENT }}>
            {shown.map((n) => (
              <Fragment key={n.session.id}>
                {renderTaskRow(n.session, cells.get(n.session.id))}
                {renderChildren(n.session.id, n.children, 1)}
              </Fragment>
            ))}
            {ordered.length > shown.length && (
              <button
                type="button"
                onClick={() => setShowAll((prev) => ({ ...prev, [session.id]: true }))}
                className="flex h-[26px] max-md:h-11 w-full items-center pl-1.5 text-left text-[11px] text-text-subtle hover:text-text-secondary"
              >
                Show {ordered.length - shown.length} more
              </button>
            )}
          </div>
        )}
      </Fragment>
    );
  }

  function renderRoot(root: SessionTreeRoot) {
    const spec = root.session && root.children.length > 0 ? specByChat.get(root.id) : undefined;
    if (spec && root.session) return renderSpecFamily(root.session, root.children, spec);
    return (
      <Fragment key={root.id}>
        {root.session ? renderRow(root.session, 0) : (
          // The creator is not in the list (a later page, or another tag): this row stands in for it.
          <button
            type="button"
            onClick={() => {
              void openLinkedSession({
                projectName, providerId: root.children[0]!.session.providerId,
                sessionId: root.id, title: root.parentTitle ?? undefined,
              });
              onNavigate?.();
            }}
            className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-text-secondary hover:bg-surface-elevated transition-colors"
          >
            <GitBranch className="size-3.5 shrink-0 text-info" />
            <span className="truncate text-[13px] font-medium">{root.parentTitle?.trim() || "Another session"}</span>
          </button>
        )}
        {renderChildren(root.id, root.children, 1)}
      </Fragment>
    );
  }

  // In the sidebar it sits in the header, where Source Control keeps its own list/tree switch.
  const viewToggle = (
    <Button
      variant="ghost"
      size="icon-xs"
      className={isSidebar ? "max-md:size-11" : undefined}
      onClick={() => setViewMode(viewMode === "tree" ? "flat" : "tree")}
      title={viewMode === "tree" ? "Show as a list" : "Group under the chat that opened them"}
      aria-label={viewMode === "tree" ? "Show as a list" : "Show as a tree"}
      aria-pressed={viewMode === "tree"}
    >
      {viewMode === "tree" ? <List className="size-3.5" /> : <FolderTree className="size-3.5" />}
    </Button>
  );

  return (
    <div className={cn(isSidebar ? "flex flex-col h-full min-h-0" : "border-t border-border/30 bg-surface", className)}>
      {/* Header (sidebar only — the bar variant already sits under its own toolbar) */}
      {isSidebar && (
        <SidebarHeader icon={BotMessageSquare} title="Chat History">
          {project && <SessionListSyncIndicator project={project} />}
          {viewToggle}
        </SidebarHeader>
      )}

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
        {!isSidebar && viewToggle}
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
            {viewMode === "tree" ? tree.map(renderRoot) : h.filteredSessions.map((s) => renderRow(s, 0))}
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
