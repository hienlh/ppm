import { useRef, useState, useCallback, useSyncExternalStore } from "react";
import { usePanelStore } from "@/stores/panel-store";

export const TAB_DRAG_TYPE = "application/ppm-tab";

export interface DragPayload {
  tabId: string;
  panelId: string;
}

// ---------------------------------------------------------------------------
// Global drag state — lets overlays know a tab drag is in progress
// ---------------------------------------------------------------------------
let _dragging = false;
const _listeners = new Set<() => void>();

function setDragging(v: boolean) {
  if (_dragging === v) return;
  _dragging = v;
  _listeners.forEach((fn) => fn());
}

export function useIsDraggingTab(): boolean {
  return useSyncExternalStore(
    (cb) => { _listeners.add(cb); return () => _listeners.delete(cb); },
    () => _dragging,
  );
}

/** Call from any drop handler to clear global drag state */
export function clearDragging() {
  setDragging(false);
}

// ---------------------------------------------------------------------------
// Hook for tab bar DnD
// ---------------------------------------------------------------------------
export function useTabDrag(panelId: string) {
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const dragOverRef = useRef<string | null>(null);

  const handleDragStart = useCallback(
    (e: React.DragEvent, tabId: string) => {
      const payload: DragPayload = { tabId, panelId };
      e.dataTransfer.setData(TAB_DRAG_TYPE, JSON.stringify(payload));
      e.dataTransfer.effectAllowed = "move";
      // Delay so browser captures the drag image first
      requestAnimationFrame(() => setDragging(true));
    },
    [panelId],
  );

  const handleDragOver = useCallback(
    (e: React.DragEvent, tabId: string, tabIndex: number) => {
      if (!e.dataTransfer.types.includes(TAB_DRAG_TYPE)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";

      if (dragOverRef.current === tabId) return;
      dragOverRef.current = tabId;

      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const midX = rect.left + rect.width / 2;
      setDropIndex(e.clientX < midX ? tabIndex : tabIndex + 1);
    },
    [],
  );

  const handleDragOverBar = useCallback(
    (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes(TAB_DRAG_TYPE)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    },
    [],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      const raw = e.dataTransfer.getData(TAB_DRAG_TYPE);
      if (!raw) return;

      try {
        const payload = JSON.parse(raw) as DragPayload;
        const store = usePanelStore.getState();

        if (payload.panelId === panelId) {
          if (dropIndex !== null) store.reorderTab(payload.tabId, panelId, dropIndex);
        } else {
          store.moveTab(payload.tabId, payload.panelId, panelId, dropIndex ?? undefined);
        }
      } catch { /* ignore */ }

      setDropIndex(null);
      dragOverRef.current = null;
    },
    [panelId, dropIndex],
  );

  const handleDragEnd = useCallback(() => {
    setDragging(false);
    setDropIndex(null);
    dragOverRef.current = null;
  }, []);

  return { dropIndex, handleDragStart, handleDragOver, handleDragOverBar, handleDrop, handleDragEnd };
}
