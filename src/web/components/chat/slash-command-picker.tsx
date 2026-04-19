import { useState, useEffect, useRef, useCallback, useMemo, type KeyboardEvent } from "react";
import { Sparkles, Terminal, Zap, RefreshCw, Clock } from "lucide-react";
import { api, projectUrl } from "@/lib/api-client";
import { searchFuzzy } from "../../../shared/fuzzy-search";

export interface SlashItem {
  type: "skill" | "command" | "builtin";
  name: string;
  description: string;
  argumentHint?: string;
  scope?: "project" | "user" | "bundled";
  category?: string;
  aliases?: string[];
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
}

export function SlashCommandPicker({
  items,
  filter,
  onSelect,
  onClose,
  visible,
  recentNames = [],
  projectName,
}: SlashCommandPickerProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  const recentSet = useMemo(() => new Set(recentNames), [recentNames]);

  // Build display list: fuzzy search when filter is set, recents-first when idle
  const displayItems = useMemo(() => {
    if (filter) {
      // Client-side fuzzy search (Levenshtein) — replaces old server-side search
      return { items: searchFuzzy(items, filter, 20, recentNames), recentCount: 0 };
    }

    // No filter — show all items with recents first
    if (recentNames.length > 0) {
      const recents: SlashItem[] = [];
      const rest: SlashItem[] = [];
      for (const item of items) {
        if (recentSet.has(item.name)) recents.push(item);
        else rest.push(item);
      }
      recents.sort((a, b) => recentNames.indexOf(a.name) - recentNames.indexOf(b.name));
      return { items: [...recents, ...rest], recentCount: recents.length };
    }
    return { items, recentCount: 0 };
  }, [items, filter, recentNames, recentSet]);

  const filtered = displayItems.items;
  const recentCount = displayItems.recentCount;

  // Reset selection when filter changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [filter]);

  // Scroll selected item into view
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const selected = list.children[selectedIndex] as HTMLElement | undefined;
    selected?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent | globalThis.KeyboardEvent) => {
      if (!visible || filtered.length === 0) return false;

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
        case "Escape":
          e.preventDefault();
          onClose();
          return true;
      }
      return false;
    },
    [visible, filtered, selectedIndex, onSelect, onClose],
  );

  // Global keyboard handler (captures before textarea)
  useEffect(() => {
    if (!visible) return;
    const handler = (e: globalThis.KeyboardEvent) => {
      if (handleKeyDown(e)) e.stopPropagation();
    };
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, [visible, handleKeyDown]);

  const handleRefresh = useCallback(() => {
    if (!projectName || refreshing) return;
    setRefreshing(true);
    api.del(`${projectUrl(projectName)}/chat/slash-items/cache`)
      .then(() => {
        // Trigger re-fetch by dispatching custom event (MessageInput listens on projectName)
        window.dispatchEvent(new CustomEvent("ppm:slash-items-refresh"));
      })
      .finally(() => setRefreshing(false));
  }, [projectName, refreshing]);

  if (!visible || filtered.length === 0) return null;

  return (
    <div className="max-h-52 overflow-y-auto border-b border-border bg-surface">
      <div ref={listRef} className="py-1">
        {filtered.map((item, i) => {
          // Show "Recent" separator before first item, "All" before first non-recent
          const showRecentLabel = recentCount > 0 && i === 0;
          const showAllLabel = recentCount > 0 && i === recentCount;

          return (
            <div key={`${item.type}-${item.name}`}>
              {showRecentLabel && (
                <div className="flex items-center justify-between px-3 pt-1 pb-0.5">
                  <span className="text-[10px] font-medium text-text-subtle uppercase tracking-wider flex items-center gap-1">
                    <Clock className="size-3" />
                    Recent
                  </span>
                  {projectName && (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); handleRefresh(); }}
                      className="text-text-subtle hover:text-text-primary transition-colors p-0.5 rounded"
                      title="Refresh skill list"
                      aria-label="Refresh skill list"
                    >
                      <RefreshCw className={`size-3 ${refreshing ? "animate-spin" : ""}`} />
                    </button>
                  )}
                </div>
              )}
              {showAllLabel && (
                <div className="px-3 pt-1.5 pb-0.5">
                  <span className="text-[10px] font-medium text-text-subtle uppercase tracking-wider">All</span>
                </div>
              )}
              <button
                className={`flex items-start gap-3 w-full px-3 py-2 text-left transition-colors ${
                  i === selectedIndex
                    ? "bg-primary/10 text-primary"
                    : "hover:bg-surface-hover text-text-primary"
                }`}
                onMouseEnter={() => setSelectedIndex(i)}
                onClick={() => onSelect(item)}
              >
                <span className="shrink-0 mt-0.5">
                  {item.type === "builtin" ? (
                    <Zap className="size-4 text-emerald-500" />
                  ) : item.type === "skill" ? (
                    <Sparkles className="size-4 text-amber-500" />
                  ) : (
                    <Terminal className="size-4 text-blue-500" />
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="font-medium text-sm">/{item.name}</span>
                    {item.argumentHint && (
                      <span className="text-xs text-text-subtle">{item.argumentHint}</span>
                    )}
                    <span className="text-xs text-text-subtle capitalize ml-auto">
                      {item.scope === "bundled" ? "PPM" : item.scope === "user" ? "global" : item.type}
                    </span>
                  </div>
                  {item.description && (
                    <p className="text-xs text-text-subtle mt-0.5 line-clamp-2">
                      {item.description}
                    </p>
                  )}
                </div>
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
