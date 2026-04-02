import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { Check, Search } from "lucide-react";
import { useExtensionStore, type QuickPickItemUI } from "@/stores/extension-store";
import { cn } from "@/lib/utils";

/** Modal overlay for extension-driven QuickPick selection */
export function ExtensionQuickPick() {
  const quickPick = useExtensionStore((s) => s.quickPick);
  const resolveQuickPick = useExtensionStore((s) => s.resolveQuickPick);

  if (!quickPick) return null;

  return (
    <QuickPickModal
      items={quickPick.items}
      options={quickPick.options}
      onSelect={(selected) => resolveQuickPick(selected)}
      onCancel={() => resolveQuickPick(undefined)}
    />
  );
}

function QuickPickModal({
  items,
  options,
  onSelect,
  onCancel,
}: {
  items: QuickPickItemUI[];
  options: { placeholder?: string; canPickMany?: boolean };
  onSelect: (selected: QuickPickItemUI[]) => void;
  onCancel: () => void;
}) {
  const [query, setQuery] = useState("");
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [picked, setPicked] = useState<Set<number>>(() => {
    const initial = new Set<number>();
    items.forEach((item, i) => { if (item.picked) initial.add(i); });
    return initial;
  });
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const canPickMany = options.canPickMany ?? false;

  useEffect(() => {
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  const filtered = useMemo(() => {
    if (!query.trim()) return items.map((item, i) => ({ item, originalIdx: i }));
    const q = query.toLowerCase();
    return items
      .map((item, i) => ({ item, originalIdx: i }))
      .filter(({ item }) =>
        item.label.toLowerCase().includes(q) ||
        item.description?.toLowerCase().includes(q) ||
        item.detail?.toLowerCase().includes(q),
      );
  }, [items, query]);

  // Clamp selection when filter changes
  useEffect(() => {
    setSelectedIdx((prev) => Math.min(prev, Math.max(filtered.length - 1, 0)));
  }, [filtered.length]);

  // Scroll selected into view
  useEffect(() => {
    const el = listRef.current?.children[selectedIdx] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedIdx]);

  const confirmSelection = useCallback(() => {
    if (canPickMany) {
      const selected = items.filter((_, i) => picked.has(i));
      onSelect(selected);
    } else if (filtered[selectedIdx]) {
      onSelect([filtered[selectedIdx].item]);
    }
  }, [canPickMany, picked, items, filtered, selectedIdx, onSelect]);

  function handleKeyDown(e: React.KeyboardEvent) {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        if (filtered.length > 0) setSelectedIdx((i) => (i + 1) % filtered.length);
        break;
      case "ArrowUp":
        e.preventDefault();
        if (filtered.length > 0) setSelectedIdx((i) => (i - 1 + filtered.length) % filtered.length);
        break;
      case " ":
        if (canPickMany && filtered[selectedIdx]) {
          e.preventDefault();
          const origIdx = filtered[selectedIdx].originalIdx;
          setPicked((prev) => {
            const next = new Set(prev);
            if (next.has(origIdx)) next.delete(origIdx); else next.add(origIdx);
            return next;
          });
        }
        break;
      case "Enter":
        e.preventDefault();
        confirmSelection();
        break;
      case "Escape":
        e.preventDefault();
        onCancel();
        break;
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end md:items-start justify-center md:pt-[20vh]" onClick={onCancel}>
      <div className="fixed inset-0 bg-black/50" />
      <div
        className="relative z-10 w-full max-w-md rounded-t-xl md:rounded-xl border border-border bg-background shadow-2xl overflow-hidden max-h-[80vh] md:max-h-none"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        {/* Search input */}
        <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
          <Search className="size-4 text-text-subtle shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={options.placeholder ?? "Select an item..."}
            className="flex-1 bg-transparent text-sm text-text-primary outline-none placeholder:text-text-subtle"
          />
          <kbd className="hidden sm:inline-flex items-center rounded border border-border bg-surface px-1.5 py-0.5 text-[10px] text-text-subtle font-mono">
            ESC
          </kbd>
        </div>

        {/* Results */}
        <div ref={listRef} className="max-h-72 overflow-y-auto py-1">
          {filtered.length === 0 ? (
            <p className="px-3 py-4 text-sm text-text-subtle text-center">No matching items</p>
          ) : (
            filtered.map(({ item, originalIdx }, i) => (
              <button
                key={originalIdx}
                onClick={() => {
                  if (canPickMany) {
                    setPicked((prev) => {
                      const next = new Set(prev);
                      if (next.has(originalIdx)) next.delete(originalIdx); else next.add(originalIdx);
                      return next;
                    });
                  } else {
                    onSelect([item]);
                  }
                }}
                className={cn(
                  "flex items-center gap-3 w-full px-3 py-2 text-sm text-left transition-colors",
                  i === selectedIdx ? "bg-accent/15 text-text-primary" : "text-text-secondary hover:bg-surface-elevated",
                )}
              >
                {canPickMany && (
                  <span className={cn(
                    "size-4 shrink-0 rounded border flex items-center justify-center",
                    picked.has(originalIdx) ? "bg-primary border-primary text-primary-foreground" : "border-border",
                  )}>
                    {picked.has(originalIdx) && <Check className="size-3" />}
                  </span>
                )}
                <div className="flex-1 min-w-0">
                  <div className="truncate">{item.label}</div>
                  {item.description && <span className="text-xs text-text-subtle ml-2">{item.description}</span>}
                  {item.detail && <div className="text-xs text-text-subtle truncate mt-0.5">{item.detail}</div>}
                </div>
              </button>
            ))
          )}
        </div>

        {/* Footer hint for multi-select */}
        {canPickMany && (
          <div className="flex items-center justify-between border-t border-border px-3 py-1.5">
            <span className="text-[10px] text-text-subtle">{picked.size} selected</span>
            <button
              onClick={confirmSelection}
              className="text-xs text-primary hover:text-primary/80 font-medium"
            >
              Confirm
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
