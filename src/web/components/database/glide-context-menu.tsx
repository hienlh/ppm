import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Eye, Pin, PinOff, Trash2, ExternalLink } from "lucide-react";

interface ContextMenuProps {
  position: { x: number; y: number };
  isPinned: boolean;
  onViewRow: () => void;
  onViewCell?: () => void;
  onPinRow: () => void;
  onDeleteRow: () => void;
  /** FK navigation: open referenced table filtered by this cell's value */
  onOpenFkTable?: () => void;
  /** Label for FK menu item, e.g. "Open users.id" */
  fkLabel?: string;
  onClose: () => void;
}

/**
 * Right-click / long-press context menu for grid rows.
 * Rendered via portal. Includes View JSON, Pin/Unpin, Delete with confirm.
 */
export function GlideContextMenu({
  position, isPinned, onViewRow, onViewCell, onPinRow, onDeleteRow, onOpenFkTable, fkLabel, onClose,
}: ContextMenuProps) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

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

  // Clamp to viewport
  const menuWidth = 180;
  const menuHeight = 130;
  const left = Math.min(position.x, window.innerWidth - menuWidth - 8);
  const top = Math.min(position.y, window.innerHeight - menuHeight - 8);

  const portal = document.getElementById("portal");
  if (!portal) return null;

  return createPortal(
    <div ref={ref} style={{ position: "fixed", left, top, zIndex: 10000 }}
      className="w-[180px] bg-popover border border-border rounded-md shadow-lg text-xs overflow-hidden py-1">
      <button type="button" onClick={() => { onViewRow(); onClose(); }}
        className="w-full text-left px-3 py-1.5 hover:bg-muted flex items-center gap-2 text-foreground">
        <Eye className="size-3" /> View as JSON
      </button>
      {onViewCell && (
        <button type="button" onClick={() => { onViewCell(); onClose(); }}
          className="w-full text-left px-3 py-1.5 hover:bg-muted flex items-center gap-2 text-foreground">
          <Eye className="size-3" /> View Cell
        </button>
      )}
      {onOpenFkTable && (
        <button type="button" onClick={() => { onOpenFkTable(); onClose(); }}
          className="w-full text-left px-3 py-1.5 hover:bg-muted flex items-center gap-2 text-blue-400">
          <ExternalLink className="size-3" /> {fkLabel ?? "Open Referenced Table"}
        </button>
      )}
      <button type="button" onClick={() => { onPinRow(); onClose(); }}
        className="w-full text-left px-3 py-1.5 hover:bg-muted flex items-center gap-2 text-foreground">
        {isPinned ? <PinOff className="size-3" /> : <Pin className="size-3" />}
        {isPinned ? "Unpin Row" : "Pin Row"}
      </button>
      <div className="border-t border-border my-0.5" />
      {confirmDelete ? (
        <div className="px-3 py-1.5 flex items-center gap-2">
          <button type="button" onClick={() => { onDeleteRow(); onClose(); }}
            className="text-destructive font-medium hover:underline">Delete?</button>
          <button type="button" onClick={() => setConfirmDelete(false)}
            className="text-muted-foreground hover:underline">Cancel</button>
        </div>
      ) : (
        <button type="button" onClick={() => setConfirmDelete(true)}
          className="w-full text-left px-3 py-1.5 hover:bg-muted flex items-center gap-2 text-destructive">
          <Trash2 className="size-3" /> Delete Row
        </button>
      )}
    </div>,
    portal,
  );
}
