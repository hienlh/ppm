import { useState, useEffect, useRef, useCallback, useMemo, type KeyboardEvent } from "react";
import { RefreshCw, Clock } from "@/lib/icons";
import { api, projectUrl } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { clearSlashItemsCache } from "@/lib/slash-items-cache";
import { idbDelete } from "@/lib/browser-cache/idb-keyval-cache";
import { projectCacheId, slash as slashKey } from "@/lib/browser-cache/cache-keys";
import { projectRefForName } from "@/stores/session-list-sync-triggers";
import { searchFuzzy } from "../../../shared/fuzzy-search";
import { PickerHeader, PickerKeyHints, PickerPanel } from "./composer-picker-parts";
import { SlashCommandPickerRow } from "./slash-command-picker-row";

export interface SlashItem {
  type: "skill" | "command" | "builtin" | "agent";
  name: string;
  description: string;
  argumentHint?: string;
  scope?: "project" | "user" | "bundled";
  category?: string;
  aliases?: string[];
  /** Agent-only: model the subagent runs on */
  model?: string;
  /** Built-in only: which layer executes the command */
  handler?: "ppm" | "sdk" | "client";
  /** Sigil the runtime needs; absent means `/`. Codex skills carry `$`. */
  invokeSigil?: "/" | "$";
  /** Pretty label the runtime supplies for itself (codex system skills). */
  displayName?: string;
  /** Runtime-supplied icon, inlined as a data URI by the server. */
  iconDataUri?: string;
}

/** The header's filter tabs. Commands covers the project's own commands and the built-ins. */
export type SlashKindFilter = "all" | "skill" | "command" | "agent";
const KIND_TABS: { id: SlashKindFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "skill", label: "Skills" },
  { id: "command", label: "Commands" },
  { id: "agent", label: "Agents" },
];

export function matchesSlashKind(item: SlashItem, kind: SlashKindFilter): boolean {
  if (kind === "all") return true;
  if (kind === "command") return item.type === "command" || item.type === "builtin";
  return item.type === kind;
}

interface SlashCommandPickerProps {
  items: SlashItem[];
  filter: string;
  onSelect: (item: SlashItem) => void;
  onClose: () => void;
  visible: boolean;
  /** Recently used item names (most recent first) */
  recentNames?: string[];
  /** Project name for cache invalidation */
  projectName?: string;
  /** `floating` (default) above the chat composer; `static` in flow, for a plain text box. */
  variant?: "floating" | "static";
}

export function SlashCommandPicker({
  items,
  filter,
  onSelect,
  onClose,
  visible,
  recentNames = [],
  projectName,
  variant = "floating",
}: SlashCommandPickerProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [kind, setKind] = useState<SlashKindFilter>("all");
  const [refreshing, setRefreshing] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  const recentSet = useMemo(() => new Set(recentNames), [recentNames]);

  // Build display list from the chosen tab: fuzzy search when filter is set, recents-first when idle
  const displayItems = useMemo(() => {
    const scoped = kind === "all" ? items : items.filter((item) => matchesSlashKind(item, kind));
    if (filter) {
      // Client-side fuzzy search (Levenshtein) — replaces old server-side search
      return { items: searchFuzzy(scoped, filter, 20, recentNames), recentCount: 0 };
    }

    // No filter — show all items with recents first
    if (recentNames.length > 0) {
      const recents: SlashItem[] = [];
      const rest: SlashItem[] = [];
      for (const item of scoped) {
        if (recentSet.has(item.name)) recents.push(item);
        else rest.push(item);
      }
      recents.sort((a, b) => recentNames.indexOf(a.name) - recentNames.indexOf(b.name));
      return { items: [...recents, ...rest], recentCount: recents.length };
    }
    return { items: scoped, recentCount: 0 };
  }, [items, filter, kind, recentNames, recentSet]);

  const filtered = displayItems.items;
  const recentCount = displayItems.recentCount;

  // Whether anything matches in any tab: a tab that happens to be empty keeps the picker open
  // (so another tab can be chosen), while a query nothing matches closes it, as it always has.
  const anyMatch = useMemo(() => {
    if (filtered.length > 0) return true;
    if (kind === "all") return false;
    return filter ? searchFuzzy(items, filter, 1).length > 0 : items.length > 0;
  }, [kind, filtered.length, filter, items]);

  // Reset selection when filter or tab changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [filter, kind]);

  // Each opening starts on All.
  useEffect(() => {
    if (!visible) setKind("all");
  }, [visible]);

  // Scroll selected item into view
  useEffect(() => {
    const selected = listRef.current?.querySelector(`[data-picker-index="${selectedIndex}"]`);
    selected?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent | globalThis.KeyboardEvent) => {
      if (!visible || !anyMatch) return false;
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return true;
      }
      if (filtered.length === 0) {
        // A tab with nothing in it: the keys that would pick do nothing, rather than send.
        if (e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          return true;
        }
        return false;
      }

      switch (e.key) {
        case "ArrowUp":
          e.preventDefault();
          setSelectedIndex((i) => (i > 0 ? i - 1 : filtered.length - 1));
          return true;
        case "ArrowDown":
          e.preventDefault();
          setSelectedIndex((i) => (i < filtered.length - 1 ? i + 1 : 0));
          return true;
        case "Enter":
        case "Tab":
          e.preventDefault();
          if (filtered[selectedIndex]) {
            onSelect(filtered[selectedIndex]);
          }
          return true;
      }
      return false;
    },
    [visible, anyMatch, filtered, selectedIndex, onSelect, onClose],
  );

  // Global keyboard handler (captures before textarea)
  useEffect(() => {
    if (!visible) return;
    const handler = (e: globalThis.KeyboardEvent) => {
      if (handleKeyDown(e)) e.stopPropagation();
    };
    // The list's own document — in a picture-in-picture window the keys are
    // delivered there, not to the main document.
    const doc = listRef.current?.ownerDocument ?? document;
    doc.addEventListener("keydown", handler, true);
    return () => doc.removeEventListener("keydown", handler, true);
  }, [visible, handleKeyDown]);

  const handleRefresh = useCallback(() => {
    if (!projectName || refreshing) return;
    setRefreshing(true);
    api.del(`${projectUrl(projectName)}/chat/slash-items/cache`)
      .then(() => {
        // Trigger re-fetch by dispatching custom event (MessageInput listens on projectName)
        clearSlashItemsCache(projectName);
        // The default provider's IndexedDB entry (what a project hydrates on the next
        // load) would otherwise keep serving the stale list until its TTL admits a fetch.
        void idbDelete(slashKey(projectCacheId(projectRefForName(projectName)), "claude"));
        window.dispatchEvent(new CustomEvent("ppm:slash-items-refresh"));
      })
      .finally(() => setRefreshing(false));
  }, [projectName, refreshing]);

  if (!visible || !anyMatch) return null;

  const header = (
    <PickerHeader>
      <div role="tablist" aria-label="Filter by kind" className="-ml-1 flex min-w-0 gap-0.5 overflow-x-auto [scrollbar-width:none] max-md:-my-2 max-md:py-2">
        {KIND_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={kind === tab.id}
            onClick={() => setKind(tab.id)}
            className={cn(
              // Side padding equals the space above and below the 16px line (5px at 26px, 6px at 28px).
              // 28px drawn on a phone, 44px answered: the press area grows, the pill does not.
              "relative h-[26px] shrink-0 rounded-full px-[5px] text-xs whitespace-nowrap transition-colors max-md:h-7 max-md:px-1.5 max-md:after:absolute max-md:after:inset-x-0 max-md:after:-inset-y-2 max-md:after:content-['']",
              kind === tab.id
                ? "bg-accent-wash font-medium text-primary"
                : "text-text-2 can-hover:hover:bg-surface-hover can-hover:hover:text-text",
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {projectName && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); handleRefresh(); }}
          className="relative ml-auto grid size-7 shrink-0 place-items-center rounded-full text-text-3 transition-colors can-hover:hover:bg-surface-hover can-hover:hover:text-text max-md:after:absolute max-md:after:-inset-2 max-md:after:content-['']"
          title="Refresh skill list"
          aria-label="Refresh skill list"
        >
          <RefreshCw className={cn("size-3.5", refreshing && "animate-spin")} />
        </button>
      )}
    </PickerHeader>
  );

  return (
    <PickerPanel variant={variant} label="Skills and commands" header={header} footer={<PickerKeyHints />}>
      <div ref={listRef}>
        {filtered.length === 0 && (
          <p className="px-2 py-3 text-center text-text-3">No skill or command matches.</p>
        )}
        {filtered.map((item, i) => (
          <div key={`${item.type}-${item.name}`}>
            {/* "Recent" before the first item, "All" before the first non-recent one */}
            {recentCount > 0 && i === 0 && (
              <div className="flex items-center gap-1 px-2 pt-1.5 pb-0.5 text-[10px] font-medium tracking-wider text-text-3 uppercase">
                <Clock className="size-3" />
                Recent
              </div>
            )}
            {recentCount > 0 && i === recentCount && (
              <div className="px-2 pt-1.5 pb-0.5 text-[10px] font-medium tracking-wider text-text-3 uppercase">All</div>
            )}
            <SlashCommandPickerRow
              item={item}
              index={i}
              selected={i === selectedIndex}
              query={filter}
              onHover={() => setSelectedIndex(i)}
              onPick={() => onSelect(item)}
            />
          </div>
        ))}
      </div>
    </PickerPanel>
  );
}
