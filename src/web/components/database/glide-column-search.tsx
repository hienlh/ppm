import { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";

interface ColumnSearchProps {
  columns: string[];
  onSelect: (colName: string) => void;
  onClose: () => void;
  anchorRect: { x: number; y: number };
}

/** Portal dropdown for searching and jumping to a column in the grid */
export function GlideColumnSearch({ columns, onSelect, onClose, anchorRect }: ColumnSearchProps) {
  const [search, setSearch] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = search
    ? columns.filter((c) => c.toLowerCase().includes(search.toLowerCase()))
    : columns;

  // Reset active index when filter changes
  useEffect(() => { setActiveIdx(0); }, [search]);

  // Scroll active item into view
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const active = list.children[activeIdx] as HTMLElement | undefined;
    active?.scrollIntoView({ block: "nearest" });
  }, [activeIdx]);

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Escape") { onClose(); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); setActiveIdx((i) => Math.min(i + 1, filtered.length - 1)); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); setActiveIdx((i) => Math.max(i - 1, 0)); return; }
    if (e.key === "Enter") {
      e.preventDefault();
      const col = filtered[activeIdx];
      if (col) { onSelect(col); onClose(); }
    }
  }, [filtered, activeIdx, onSelect, onClose]);

  const portal = document.getElementById("portal");
  if (!portal) return null;

  return createPortal(
    <div ref={ref} style={{ position: "fixed", left: Math.min(anchorRect.x, window.innerWidth - 216), top: Math.min(anchorRect.y, window.innerHeight - 308), zIndex: 10000 }}
      className="w-[200px] max-h-[300px] bg-popover border border-border rounded-md shadow-lg text-xs overflow-hidden flex flex-col">
      <div className="px-2 py-1.5 border-b border-border">
        <input autoFocus value={search} onChange={(e) => setSearch(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Search columns…"
          className="w-full bg-transparent outline-none text-foreground placeholder:text-muted-foreground text-xs" />
      </div>
      <div ref={listRef} className="overflow-y-auto py-1">
        {filtered.map((col, i) => (
          <button key={col} type="button"
            onClick={() => { onSelect(col); onClose(); }}
            onMouseEnter={() => setActiveIdx(i)}
            className={`w-full text-left px-3 py-1 truncate text-foreground ${i === activeIdx ? "bg-muted" : "hover:bg-muted"}`}>
            {col}
          </button>
        ))}
        {filtered.length === 0 && (
          <div className="px-3 py-2 text-muted-foreground">No columns found</div>
        )}
      </div>
    </div>,
    portal,
  );
}
