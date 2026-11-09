import { useState, useEffect, useRef, useCallback, useMemo, type KeyboardEvent } from "react";
import { File, Folder } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { StartEllipsis } from "@/components/ui/start-ellipsis";
import type { FileNode } from "../../../types/project";
import { HighlightMatch, PickerHeader, PickerKeyHints, PickerPanel } from "./composer-picker-parts";

interface FilePickerProps {
  items: FileNode[];
  filter: string;
  onSelect: (item: FileNode) => void;
  onClose: () => void;
  visible: boolean;
}

const MAX_ROWS = 50;

/** A row's two halves: the name (a folder's with a trailing `/`) and the directory holding it. */
export function splitFilePath(node: Pick<FileNode, "path" | "type">): { name: string; dir: string } {
  const path = node.path.replace(/[\\/]+$/, "");
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const name = path.slice(cut + 1) + (node.type === "directory" ? "/" : "");
  return { name, dir: cut >= 0 ? path.slice(0, cut + 1) : "" };
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

  // Every match, for the header's count; the list shows the first MAX_ROWS of them.
  const matches = useMemo(() => {
    if (!filter) return items;
    const q = filter.toLowerCase();
    return items.filter((node) => node.path.toLowerCase().includes(q) || node.name.toLowerCase().includes(q));
  }, [items, filter]);
  const filtered = matches.length > MAX_ROWS ? matches.slice(0, MAX_ROWS) : matches;

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
    // The list's own document — in a picture-in-picture window the keys are
    // delivered there, not to the main document.
    const doc = listRef.current?.ownerDocument ?? document;
    doc.addEventListener("keydown", handler, true);
    return () => doc.removeEventListener("keydown", handler, true);
  }, [visible, handleKeyDown]);

  if (!visible || filtered.length === 0) return null;

  const count = `${matches.length} match${matches.length === 1 ? "" : "es"}`;
  const header = (
    <PickerHeader>
      <b className="text-[13px] font-semibold">Files</b>
      <span className="ml-auto min-w-0 truncate pr-1 text-text-3">{filter ? `${count} for “${filter}”` : count}</span>
    </PickerHeader>
  );

  return (
    <PickerPanel label="Files" header={header} footer={<PickerKeyHints />}>
      <div ref={listRef}>
        {filtered.map((item, i) => {
          const { name, dir } = splitFilePath(item);
          const isDir = item.type === "directory";
          return (
            <button
              key={item.path}
              type="button"
              role="option"
              aria-selected={i === selectedIndex}
              title={item.path}
              className={cn(
                // Narrow or touch: 44px rows, and the directory wraps under the name.
                "grid min-h-9 w-full grid-cols-[24px_auto_minmax(0,1fr)] items-center gap-x-2.5 rounded-lg px-2 py-1.5 text-left transition-colors",
                "@max-[420px]/chat:min-h-11 @max-[420px]/chat:grid-cols-[24px_minmax(0,1fr)] max-md:min-h-11 max-md:grid-cols-[24px_minmax(0,1fr)] [@media(hover:none)]:min-h-11 [@media(hover:none)]:grid-cols-[24px_minmax(0,1fr)]",
                i === selectedIndex ? "bg-accent-wash" : "can-hover:hover:bg-surface-hover",
              )}
              onMouseEnter={() => setSelectedIndex(i)}
              onClick={() => onSelect(item)}
            >
              <span className={cn("grid size-6 place-items-center", isDir ? "text-warning" : "text-text-3")}>
                {isDir ? <Folder className="size-3.5" /> : <File className="size-3.5" />}
              </span>
              <span className="min-w-0 truncate text-[13px] font-medium text-text">
                <HighlightMatch text={name} query={filter} />
              </span>
              {dir && (
                <span className="flex min-w-0 text-xs text-text-3 @max-[420px]/chat:col-start-2 @max-[420px]/chat:-mt-1 max-md:col-start-2 max-md:-mt-1 [@media(hover:none)]:col-start-2 [@media(hover:none)]:-mt-1">
                  <StartEllipsis><HighlightMatch text={dir} query={filter} /></StartEllipsis>
                </span>
              )}
            </button>
          );
        })}
      </div>
    </PickerPanel>
  );
}
