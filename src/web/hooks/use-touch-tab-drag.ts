import { useCallback, useRef, useSyncExternalStore } from "react";
import { setDragging, clearDragging, type DragPayload } from "./use-tab-drag";
import { usePanelStore } from "@/stores/panel-store";
import { findPanelPosition, maxColumns, MAX_ROWS } from "@/stores/panel-utils";

type DropZone = "left" | "right" | "top" | "bottom" | "center";

// ---------------------------------------------------------------------------
// Global touch-drag state
// ---------------------------------------------------------------------------
let _payload: DragPayload | null = null;
let _zone: { panelId: string; zone: DropZone } | null = null;
let _recentEnd = 0;

const _zoneListeners = new Set<() => void>();
function notifyZone() { _zoneListeners.forEach((fn) => fn()); }

/** Subscribe to the current touch-drag drop zone (for SplitDropOverlay) */
export function useTouchDropZone() {
  return useSyncExternalStore(
    (cb) => { _zoneListeners.add(cb); return () => _zoneListeners.delete(cb); },
    () => _zone,
  );
}

/** True briefly after a touch drag ends — used to suppress the tap-to-select click */
export function wasTouchDragRecent() { return Date.now() - _recentEnd < 300; }

// ---------------------------------------------------------------------------
// Ghost element (floating label that follows the finger)
// ---------------------------------------------------------------------------
let _ghost: HTMLElement | null = null;

function showGhost(label: string, x: number, y: number) {
  const el = document.createElement("div");
  el.id = "touch-drag-ghost";
  Object.assign(el.style, {
    position: "fixed", zIndex: "9999", pointerEvents: "none",
    padding: "6px 14px", borderRadius: "8px",
    background: "rgba(30,30,30,0.92)", color: "#fff",
    fontSize: "12px", whiteSpace: "nowrap", opacity: "0.95",
    boxShadow: "0 4px 16px rgba(0,0,0,0.35)",
    transform: "translate(-50%, -130%)",
    left: `${x}px`, top: `${y}px`,
  });
  el.textContent = label;
  document.body.appendChild(el);
  _ghost = el;
}

function moveGhostTo(x: number, y: number) {
  if (_ghost) { _ghost.style.left = `${x}px`; _ghost.style.top = `${y}px`; }
}

function removeGhost() { _ghost?.remove(); _ghost = null; }

// ---------------------------------------------------------------------------
// Zone detection — find which panel & zone the finger is over
// ---------------------------------------------------------------------------
function detectZone(x: number, y: number): { panelId: string; zone: DropZone } | null {
  // Hide ghost so elementFromPoint sees the panel underneath
  if (_ghost) _ghost.style.display = "none";
  const el = document.elementFromPoint(x, y);
  if (_ghost) _ghost.style.display = "";

  const container = el?.closest("[data-panel-drop-zone]") as HTMLElement | null;
  if (!container) return null;

  const panelId = container.dataset.panelDropZone!;
  const rect = container.getBoundingClientRect();
  const rx = (x - rect.left) / rect.width;
  const ry = (y - rect.top) / rect.height;
  const T = 0.25;

  const { grid } = usePanelStore.getState();
  const isMobile = window.innerWidth < 768;
  const pos = findPanelPosition(grid, panelId);
  const canH = pos ? !isMobile && (grid[pos.row]?.length ?? 0) < maxColumns(false) : false;
  const canV = !isMobile && grid.length < MAX_ROWS;

  let zone: DropZone = "center";
  if (rx < T && canH) zone = "left";
  else if (rx > 1 - T && canH) zone = "right";
  else if (ry < T && canV) zone = "top";
  else if (ry > 1 - T && canV) zone = "bottom";

  return { panelId, zone };
}

// ---------------------------------------------------------------------------
// Document-level touch handlers (attached when drag starts)
// ---------------------------------------------------------------------------
function onTouchMove(e: TouchEvent) {
  if (!_payload) return;
  e.preventDefault(); // prevent scroll while dragging
  const t = e.touches[0];
  if (!t) return;
  moveGhostTo(t.clientX, t.clientY);

  const newZone = detectZone(t.clientX, t.clientY);
  if (newZone?.panelId !== _zone?.panelId || newZone?.zone !== _zone?.zone) {
    _zone = newZone;
    notifyZone();
  }
}

function cleanup() {
  _payload = null;
  _zone = null;
  notifyZone();
  removeGhost();
  clearDragging();
  document.removeEventListener("touchmove", onTouchMove);
  document.removeEventListener("touchend", onTouchEnd);
  document.removeEventListener("touchcancel", onTouchCancel);
}

function onTouchEnd() {
  const payload = _payload;
  const zone = _zone;
  cleanup();
  _recentEnd = Date.now();
  if (!payload || !zone) return;

  const store = usePanelStore.getState();
  if (zone.zone === "center") {
    if (payload.panelId !== zone.panelId) {
      store.moveTab(payload.tabId, payload.panelId, zone.panelId);
    }
  } else {
    const dir = zone.zone === "top" ? "up" as const
      : zone.zone === "bottom" ? "down" as const
      : zone.zone as "left" | "right";
    store.splitPanel(dir, payload.tabId, payload.panelId, zone.panelId);
  }
}

function onTouchCancel() { cleanup(); _recentEnd = Date.now(); }

function beginDrag(payload: DragPayload, label: string, x: number, y: number) {
  _payload = payload;
  setDragging(true);
  showGhost(label, x, y);
  document.addEventListener("touchmove", onTouchMove, { passive: false });
  document.addEventListener("touchend", onTouchEnd);
  document.addEventListener("touchcancel", onTouchCancel);
}

// ---------------------------------------------------------------------------
// Hook — attach to each DraggableTab in the desktop TabBar
// ---------------------------------------------------------------------------
const HOLD_MS = 200;
const MOVE_PX = 10;

export function useTouchTabDrag(panelId: string) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const started = useRef(false);

  const handleTouchStart = useCallback(
    (e: React.TouchEvent, tabId: string, label: string) => {
      const t = e.touches[0];
      if (!t) return;
      origin.current = { x: t.clientX, y: t.clientY };
      started.current = false;
      timer.current = setTimeout(() => {
        started.current = true;
        beginDrag({ tabId, panelId }, label, origin.current!.x, origin.current!.y);
      }, HOLD_MS);
    },
    [panelId],
  );

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (started.current) return; // document-level handler takes over
    if (!origin.current || !timer.current) return;
    const t = e.touches[0];
    if (!t) return;
    if (Math.abs(t.clientX - origin.current.x) > MOVE_PX || Math.abs(t.clientY - origin.current.y) > MOVE_PX) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const handleTouchEnd = useCallback(() => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
  }, []);

  return { handleTouchStart, handleTouchMove, handleTouchEnd };
}
