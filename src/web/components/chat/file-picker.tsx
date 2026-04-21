import { useState, useEffect, useRef, useCallback, type KeyboardEvent } from "react";
import { File, Folder } from "lucide-react";
import type { FileNode } from "../../../types/project";

interface FilePickerProps {
  items: FileNode[];
  filter: string;
  onSelect: (item: FileNode) => void;
  onClose: () => void;
  visible: boolean;
}

export function FilePicker({
  items,
  filter,
  onSelect,
  onClose,
  visible,
}: FilePickerProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = (() => {
    if (!filter) return items.slice(0, 50);
    const q = filter.toLowerCase();
    return items
      .filter((node) => node.path.toLowerCase().includes(q) || node.name.toLowerCase().includes(q))
      .slice(0, 50);
  })();

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

  if (!visible || filtered.length === 0) return null;

  return (
    <div className="max-h-52 overflow-y-auto border-b border-border bg-surface">
      <div ref={listRef} className="py-1">
        {filtered.map((item, i) => (
          <button
            key={item.path}
            className={`flex items-center gap-2 w-full px-3 py-1.5 text-left transition-colors ${
              i === selectedIndex
                ? "bg-primary/10 text-primary"
                : "hover:bg-surface-hover text-text-primary"
            }`}
            onMouseEnter={() => setSelectedIndex(i)}
            onClick={() => onSelect(item)}
          >
            <span className="shrink-0">
              {item.type === "directory" ? (
                <Folder className="size-4 text-amber-500" />
              ) : (
                <File className="size-4 text-blue-400" />
              )}
            </span>
            <span className="text-sm truncate">{item.path}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
