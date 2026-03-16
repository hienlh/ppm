import { useState, useCallback } from "react";
import { TAB_DRAG_TYPE, useIsDraggingTab, clearDragging, type DragPayload } from "@/hooks/use-tab-drag";
import { usePanelStore } from "@/stores/panel-store";
import { findPanelPosition, maxColumns, MAX_ROWS } from "@/stores/panel-utils";

type DropZone = "left" | "right" | "top" | "bottom" | "center" | null;

interface SplitDropOverlayProps {
  panelId: string;
}

export function SplitDropOverlay({ panelId }: SplitDropOverlayProps) {
  const [active, setActive] = useState<DropZone>(null);
  const isDragging = useIsDraggingTab();

  const grid = usePanelStore((s) => s.grid);
  const isMobile = usePanelStore((s) => s.isMobile());
  const pos = findPanelPosition(grid, panelId);

  const canSplitH = !isMobile && grid.length < maxColumns(false);
  const canSplitV = pos ? (grid[pos.col]?.length ?? 0) < MAX_ROWS : false;

  const getZone = useCallback(
    (e: React.DragEvent): DropZone => {
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width;
      const y = (e.clientY - rect.top) / rect.height;
      const t = 0.25;

      if (x < t && canSplitH) return "left";
      if (x > 1 - t && canSplitH) return "right";
      if (y < t && canSplitV) return "top";
      if (y > 1 - t && canSplitV) return "bottom";
      return "center"; // drop in center = move to this panel
    },
    [canSplitH, canSplitV],
  );

  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes(TAB_DRAG_TYPE)) return;
      e.preventDefault();
      e.stopPropagation();
      setActive(getZone(e));
    },
    [getZone],
  );

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setActive(null);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const zone = getZone(e);
      setActive(null);
      clearDragging();
      if (!zone) return;

      const raw = e.dataTransfer.getData(TAB_DRAG_TYPE);
      if (!raw) return;

      try {
        const payload = JSON.parse(raw) as DragPayload;
        const store = usePanelStore.getState();

        if (zone === "center") {
          // Move tab to this panel (if from different panel)
          if (payload.panelId !== panelId) {
            store.moveTab(payload.tabId, payload.panelId, panelId);
          }
        } else {
          // Split: create new panel on the TARGET panel's edge
          const direction = zone === "top" ? "up" as const : zone as "left" | "right" | "down";
          store.splitPanel(direction, payload.tabId, payload.panelId, panelId);
        }
      } catch { /* ignore */ }
    },
    [getZone, panelId],
  );

  if (!isDragging) return null;

  return (
    <div
      className="absolute inset-0 z-20"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {active === "left" && (
        <div className="absolute inset-y-0 left-0 w-1/3 bg-primary/10 border-2 border-primary/30 rounded-l-md" />
      )}
      {active === "right" && (
        <div className="absolute inset-y-0 right-0 w-1/3 bg-primary/10 border-2 border-primary/30 rounded-r-md" />
      )}
      {active === "top" && (
        <div className="absolute inset-x-0 top-0 h-1/3 bg-primary/10 border-2 border-primary/30 rounded-t-md" />
      )}
      {active === "bottom" && (
        <div className="absolute inset-x-0 bottom-0 h-1/3 bg-primary/10 border-2 border-primary/30 rounded-b-md" />
      )}
      {active === "center" && (
        <div className="absolute inset-0 bg-primary/5 border-2 border-dashed border-primary/30 rounded-md" />
      )}
    </div>
  );
}
