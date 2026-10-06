import { useEffect, useLayoutEffect, useRef, useState, type ElementType } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

export interface GridMenuItem {
  label: string;
  icon?: ElementType;
  onSelect: () => void;
  disabled?: boolean;
  destructive?: boolean;
  /** Drawn in the accent: an item that opens somewhere else. */
  accent?: boolean;
  /** The item's key, at the right. */
  hint?: string;
}

export type GridMenuEntry = GridMenuItem | "separator";

/**
 * Right-click / long-press context menu for grid cells, rendered via portal: the items it is given,
 * each closing the menu once chosen. Phase 04e gives it DBGate's full cell menu.
 */
export function GlideContextMenu({ position, items, onClose }: {
  position: { x: number; y: number };
  items: readonly GridMenuEntry[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState(position);

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

  // Kept inside the window, measured before it is painted.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setPlace({
      x: Math.max(8, Math.min(position.x, window.innerWidth - el.offsetWidth - 8)),
      y: Math.max(8, Math.min(position.y, window.innerHeight - el.offsetHeight - 8)),
    });
  }, [position, items.length]);

  const portal = document.getElementById("portal");
  if (!portal) return null;

  return createPortal(
    <div ref={ref} role="menu" style={{ position: "fixed", left: place.x, top: place.y, zIndex: 10000 }}
      className="max-h-[calc(100dvh-16px)] min-w-[200px] overflow-y-auto rounded-md border border-border bg-popover py-1 text-xs shadow-lg">
      {items.map((item, i) => {
        if (item === "separator") return <div key={`sep-${i}`} role="separator" className="my-0.5 border-t border-border" />;
        const Icon = item.icon;
        return (
          <button
            key={item.label} type="button" role="menuitem" disabled={item.disabled}
            onClick={() => { onClose(); item.onSelect(); }}
            className={cn(
              "flex w-full items-center gap-2 px-3 py-1.5 text-left text-foreground select-none can-hover:hover:bg-muted max-md:min-h-11 disabled:pointer-events-none disabled:opacity-45",
              item.destructive && "text-destructive",
              item.accent && "text-primary",
            )}
          >
            {Icon ? <Icon className="size-3 shrink-0" /> : <span className="size-3 shrink-0" aria-hidden />}
            <span className="flex-1">{item.label}</span>
            {item.hint && <kbd className="font-sans text-[10.5px] text-text-subtle">{item.hint}</kbd>}
          </button>
        );
      })}
    </div>,
    portal,
  );
}
