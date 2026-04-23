import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Filter, Pin, PinOff, ArrowUp, ArrowDown, X } from "lucide-react";

interface HeaderMenuProps {
  colName: string;
  bounds: { x: number; y: number; width: number; height: number };
  isPinned: boolean;
  filterValue: string;
  sortState: "asc" | "desc" | null;
  onFilter: (value: string) => void;
  onSort: () => void;
  onClearSort?: () => void;
  onTogglePin: () => void;
  onClose: () => void;
}

/**
 * Header column dropdown menu — filter input, sort toggle, pin/unpin.
 * Rendered via React portal into #portal div (required by Glide Data Grid).
 */
export function GlideHeaderMenu({
  colName, bounds, isPinned, filterValue, sortState,
  onFilter, onSort, onClearSort, onTogglePin, onClose,
}: HeaderMenuProps) {
  const [localFilter, setLocalFilter] = useState(filterValue);
  const ref = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  // Debounced filter
  const handleFilterChange = (val: string) => {
    setLocalFilter(val);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => onFilter(val), 300);
  };

  // Clamp position to viewport
  const menuWidth = 220;
  const left = Math.min(bounds.x, window.innerWidth - menuWidth - 8);
  const top = bounds.y + bounds.height + 2;

  const portal = document.getElementById("portal");
  if (!portal) return null;

  return createPortal(
    <div ref={ref} style={{ position: "fixed", left, top, zIndex: 10000 }}
      className="w-[220px] bg-popover border border-border rounded-md shadow-lg text-xs overflow-hidden">
      {/* Column name header */}
      <div className="px-3 py-1.5 border-b border-border text-muted-foreground font-medium truncate">
        {colName}
      </div>

      {/* Filter input */}
      <div className="px-2 py-1.5 border-b border-border">
        <div className="flex items-center gap-1">
          <Filter className="size-3 text-muted-foreground shrink-0" />
          <input
            autoFocus type="text" value={localFilter}
            onChange={(e) => handleFilterChange(e.target.value)}
            placeholder="Filter (ILIKE)…"
            className="flex-1 bg-transparent outline-none text-foreground placeholder:text-muted-foreground text-xs"
          />
          {localFilter && (
            <button type="button" onClick={() => handleFilterChange("")}
              className="text-muted-foreground hover:text-foreground">
              <X className="size-3" />
            </button>
          )}
        </div>
      </div>

      {/* Actions */}
      <div className="py-1">
        <button type="button" onClick={() => { onSort(); onClose(); }}
          className="w-full text-left px-3 py-1.5 hover:bg-muted flex items-center gap-2 text-foreground">
          {sortState === "asc" ? <ArrowDown className="size-3" /> : <ArrowUp className="size-3" />}
          {sortState === "asc" ? "Sort Descending" : "Sort Ascending"}
        </button>
        {sortState && onClearSort && (
          <button type="button" onClick={() => { onClearSort(); onClose(); }}
            className="w-full text-left px-3 py-1.5 hover:bg-muted flex items-center gap-2 text-foreground">
            <X className="size-3" />
            Clear Sort
          </button>
        )}
        <button type="button" onClick={() => { onTogglePin(); onClose(); }}
          className="w-full text-left px-3 py-1.5 hover:bg-muted flex items-center gap-2 text-foreground">
          {isPinned ? <PinOff className="size-3" /> : <Pin className="size-3" />}
          {isPinned ? "Unpin Column" : "Pin Column"}
        </button>
      </div>
    </div>,
    portal,
  );
}
