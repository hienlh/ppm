import { useState, useEffect, useRef, useCallback, type KeyboardEvent } from "react";
import { Sparkles, Terminal } from "lucide-react";

export interface SlashItem {
  type: "skill" | "command";
  name: string;
  description: string;
  argumentHint?: string;
  scope?: "project" | "user";
}

interface SlashCommandPickerProps {
  items: SlashItem[];
  filter: string;
  onSelect: (item: SlashItem) => void;
  onClose: () => void;
  visible: boolean;
}

export function SlashCommandPicker({
  items,
  filter,
  onSelect,
  onClose,
  visible,
}: SlashCommandPickerProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = items.filter((item) => {
    const q = filter.toLowerCase();
    return (
      item.name.toLowerCase().includes(q) ||
      item.description.toLowerCase().includes(q)
    );
  });

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
      handleKeyDown(e);
    };
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, [visible, handleKeyDown]);

  if (!visible || filtered.length === 0) return null;

  return (
    <div className="max-h-52 overflow-y-auto border-b border-border bg-surface">
      <div ref={listRef} className="py-1">
        {filtered.map((item, i) => (
          <button
            key={`${item.type}-${item.name}`}
            className={`flex items-start gap-3 w-full px-3 py-2 text-left transition-colors ${
              i === selectedIndex
                ? "bg-primary/10 text-primary"
                : "hover:bg-surface-hover text-text-primary"
            }`}
            onMouseEnter={() => setSelectedIndex(i)}
            onClick={() => onSelect(item)}
          >
            <span className="shrink-0 mt-0.5">
              {item.type === "skill" ? (
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
                  {item.scope === "user" ? "global" : item.type}
                </span>
              </div>
              {item.description && (
                <p className="text-xs text-text-subtle mt-0.5 line-clamp-2">
                  {item.description}
                </p>
              )}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
