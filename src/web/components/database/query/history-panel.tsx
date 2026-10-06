/**
 * Query history, beside the Query tab as the mockup draws it (scene 10): what Query tabs ran on this
 * connection, newest first, read from the audit log PPM already keeps — searched by text, one page at
 * a time. DBGate opens an entry in a new Query tab; here a click puts its SQL in this tab's editor.
 * A desktop's only: a phone has no room beside the editor for it.
 */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { History, X } from "@/lib/icons";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { targetUrl, type DbTarget } from "@/lib/db-tabs";
import type { QueryHistoryItem, QueryHistoryResponse } from "../../../../shared/db-query-script";
import { EmptyState, SearchBox, linkButtonClass } from "../explorer/tree-parts";
import { HISTORY_STATUS_LABEL, historyHasMore, historyMeta, historyUrl, mergeHistoryPage, retentionNote } from "./query-history";

/** The panel's width beside the editor, as the mockup has it. */
const PANEL_WIDTH = 290;
/** Typing goes on this long before the log is searched. */
const SEARCH_DELAY_MS = 300;
/** How often "just now" is worked out again. */
const CLOCK_MS = 60_000;

const DOT: Record<QueryHistoryItem["status"], string> = { ok: "bg-success", error: "bg-error", blocked: "bg-warning" };

interface HistoryState {
  items: QueryHistoryItem[];
  /** The last page was full: the log may hold more. */
  more: boolean;
  retention: { days: number; maxSizeMb: number } | null;
  loading: boolean;
  /** Why the last read failed, and from where it read: Try again reads that page again. */
  error: { message: string; offset: number } | null;
}

export function HistoryPanel({ target, refreshKey, floating, onPick, onClose }: {
  target: DbTarget;
  /** Changes when one of the tab's runs has ended: the list is read again, that run at its top. */
  refreshKey: number;
  /** Over the editor's right edge, in a tab too narrow to keep it beside the editor. */
  floating: boolean;
  onPick: (sql: string) => void;
  onClose: () => void;
}) {
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [search]);

  const [state, setState] = useState<HistoryState>({ items: [], more: false, retention: null, loading: true, error: null });
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => clearInterval(timer);
  }, []);

  // Only the latest request is shown: a search typed on, or a run ended, makes the one before it stale.
  const latest = useRef(0);
  const shownRef = useRef<QueryHistoryItem[]>([]);
  const targetRef = useRef(target);
  targetRef.current = target;
  const load = useCallback(async (offset: number) => {
    const id = ++latest.current;
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const page = await api.get<QueryHistoryResponse>(historyUrl(targetRef.current, query, offset));
      if (id !== latest.current) return;
      const items = mergeHistoryPage(shownRef.current, page.items, offset);
      shownRef.current = items;
      setNow(Date.now());
      setState({
        items, more: historyHasMore(page.items), retention: { days: page.retentionDays, maxSizeMb: page.maxSizeMb }, loading: false, error: null,
      });
    } catch (e) {
      if (id !== latest.current) return;
      setState((s) => ({ ...s, loading: false, error: { message: (e as Error).message, offset } }));
    }
  }, [query]);

  const where = targetUrl(target);
  useEffect(() => { void load(0); }, [load, where, refreshKey]);

  // Opened floating, the panel is there to pick from: the keyboard goes to its search, and back to what
  // had it once the panel is put away. One that came to float because the tab narrowed while it was
  // open is not where anyone is typing, so the keyboard is left where it is.
  const searchRef = useRef<HTMLInputElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!floating) return;
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    searchRef.current?.focus();
  }, []);
  const close = () => {
    onClose();
    openerRef.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (!floating || e.key !== "Escape" || e.defaultPrevented) return;
    e.preventDefault();
    e.stopPropagation();
    close();
  };

  const { items, more, retention, loading, error } = state;
  return (
    <aside
      aria-label="Query history" onKeyDown={onKeyDown}
      style={{ width: floating ? `min(${PANEL_WIDTH}px, 86%)` : PANEL_WIDTH }}
      className={cn(
        "flex shrink-0 flex-col overflow-hidden border-l border-border bg-panel",
        floating && "absolute inset-y-0 right-0 z-30 shadow-[-14px_0_34px_-14px_rgb(0_0_0/0.45)]",
      )}
    >
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-border-soft pr-1 pl-2.5 text-xs font-semibold text-text-primary">
        <History aria-hidden className="size-4 shrink-0 text-text-2" />History
        <span className="flex-1" />
        <button
          type="button" onClick={close} aria-label="Close history" title="Close history"
          className="grid size-7 place-items-center rounded text-text-2 can-hover:hover:bg-surface-hover can-hover:hover:text-text-primary"
        >
          <X className="size-3.5" />
        </button>
      </div>
      <div className="flex shrink-0 px-2.5 py-2">
        <SearchBox value={search} onChange={setSearch} placeholder="Search history" inputRef={searchRef} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2" aria-busy={loading}>
        {items.map((item) => (
          <button
            key={item.id} type="button" onClick={() => onPick(item.sql)} title={item.sql}
            className={cn(
              "mb-0.5 block w-full rounded-md border border-transparent px-2 py-1.5 text-left",
              "can-hover:hover:border-border can-hover:hover:bg-surface-hover focus-visible:border-primary focus-visible:outline-none",
            )}
          >
            <span className="mb-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-text-subtle">
              <span role="img" aria-label={HISTORY_STATUS_LABEL[item.status]} className={cn("size-[7px] shrink-0 rounded-full", DOT[item.status])} />
              <span className="truncate">{historyMeta(item, now).join(" · ")}</span>
              {item.byAgent && (
                <span title="An AI agent ran it" className="ml-auto shrink-0 rounded border border-border px-1 text-[10px] leading-4">agent</span>
              )}
            </span>
            <span className="line-clamp-2 font-mono text-[11.5px] leading-[1.45] break-all text-text-primary">{item.sql}</span>
            {item.status === "error" && item.error && <span className="mt-0.5 line-clamp-2 text-[11px] text-error">{item.error}</span>}
            {item.status === "blocked" && (
              <span className="mt-0.5 line-clamp-2 text-[11px] text-warning">Blocked: {item.error ?? "not allowed on this connection"}</span>
            )}
          </button>
        ))}
        {error ? (
          <EmptyState>
            <span role="alert" className="text-error">Could not read the history: {error.message}</span>
            <button type="button" onClick={() => void load(error.offset)} className={linkButtonClass}>Try again</button>
          </EmptyState>
        ) : loading && items.length === 0 ? (
          <EmptyState>Reading the history…</EmptyState>
        ) : items.length === 0 ? (
          <EmptyState>{query.trim() ? "No query run here matches." : "Nothing has been run here yet."}</EmptyState>
        ) : more ? (
          <button
            type="button" onClick={() => void load(items.length)} disabled={loading}
            className="mt-1 h-7 w-full rounded-md border border-border text-xs text-text-2 can-hover:hover:bg-surface-hover disabled:opacity-50"
          >
            {loading ? "Reading…" : "Load more"}
          </button>
        ) : null}
      </div>
      {retention && (
        <div className="shrink-0 border-t border-border-soft px-3 py-2 text-[11px] leading-snug text-text-subtle">
          {retentionNote(retention.days, retention.maxSizeMb)}
        </div>
      )}
    </aside>
  );
}
