import { useRef, useState, useEffect } from "react";
import { MoreHorizontal } from "lucide-react";
import { BottomSheet } from "@/components/ui/mobile-bottom-sheet";
import { cn } from "@/lib/utils";
import type { SidebarActiveTab } from "@/stores/settings-store";
import type { SidebarTabDef } from "@/lib/sidebar-tabs/tab-registry";

const SLOT = 64; // px — fixed slot width so the temp-slot swap never shifts layout
const LONG_PRESS_MS = 350;
const DRAG_CANCEL_PX = 10;

interface Props {
  tabs: SidebarTabDef[]; // ordered + already filtered to mobile-supported ids
  activeId: SidebarActiveTab;
  onSelect: (id: SidebarActiveTab) => void;
  onReorder: (ids: SidebarActiveTab[]) => void;
}

/** Move `dragId` to sit before `targetId` in the id list. */
function reorderIds(ids: SidebarActiveTab[], dragId: SidebarActiveTab, targetId: SidebarActiveTab): SidebarActiveTab[] {
  const next = [...ids];
  const from = next.indexOf(dragId);
  if (from < 0 || dragId === targetId) return ids;
  next.splice(from, 1);
  const at = next.indexOf(targetId);
  next.splice(at < 0 ? next.length : at, 0, dragId);
  return next;
}

export function MobileDrawerTabBar({ tabs, activeId, onSelect, onReorder }: Props) {
  const barRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  // State drives rendering; refs mirror it so the non-passive touch listener and
  // touchend handler read current values (not a stale render closure).
  const [dragId, _setDragId] = useState<SidebarActiveTab | null>(null);
  const [dropId, _setDropId] = useState<SidebarActiveTab | null>(null);
  const dragRef = useRef<SidebarActiveTab | null>(null);
  const dropRef = useRef<SidebarActiveTab | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touchStart = useRef<{ x: number; y: number } | null>(null);

  const setDrag = (id: SidebarActiveTab | null) => { dragRef.current = id; _setDragId(id); };
  const setDrop = (id: SidebarActiveTab | null) => { dropRef.current = id; _setDropId(id); };
  const resetDrag = () => { setDrag(null); setDrop(null); };
  const clearPress = () => { if (pressTimer.current) { clearTimeout(pressTimer.current); pressTimer.current = null; } };

  useEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => setWidth(entries[0]!.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Non-passive touchmove: React's onTouchMove is passive (preventDefault ignored),
  // so page-scroll would fight the drag. Attach manually to suppress scroll while dragging.
  useEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const onMove = (e: TouchEvent) => {
      if (!dragRef.current) return;
      e.preventDefault();
      const t = e.touches[0];
      if (!t) return;
      const hit = document.elementFromPoint(t.clientX, t.clientY)?.closest("[data-tabid]");
      const id = hit?.getAttribute("data-tabid") as SidebarActiveTab | null;
      if (id) setDrop(id);
    };
    el.addEventListener("touchmove", onMove, { passive: false });
    return () => el.removeEventListener("touchmove", onMove);
  }, []);

  const n = width ? Math.max(1, Math.floor(width / SLOT)) : tabs.length;
  const needMore = tabs.length > n;
  const visibleSlots = needMore ? Math.max(1, n - 1) : tabs.length;

  let visible = tabs.slice(0, visibleSlots);
  const activeInOverflow = needMore && !visible.some((t) => t.id === activeId) && tabs.some((t) => t.id === activeId);
  if (activeInOverflow) {
    const activeTab = tabs.find((t) => t.id === activeId)!;
    visible = [...tabs.slice(0, visibleSlots - 1), activeTab];
  }
  const shownIds = new Set(visible.map((t) => t.id));
  const overflow = tabs.filter((t) => !shownIds.has(t.id));

  const commit = (targetId: SidebarActiveTab) => {
    if (dragRef.current) onReorder(reorderIds(tabs.map((t) => t.id), dragRef.current, targetId));
    resetDrag();
  };

  const slotClass = (id: SidebarActiveTab, active: boolean) => cn(
    "relative flex flex-col items-center justify-center gap-0.5 shrink-0 py-2.5 text-[10px] select-none transition-colors",
    active ? "text-primary" : "text-text-secondary",
    dragId === id && "opacity-40",
    dropId === id && dragId !== id && "shadow-[inset_2px_0_0_var(--accent)]",
  );

  return (
    <div ref={barRef} className="flex items-center overflow-hidden">
      {visible.map((tab) => {
        const Icon = tab.icon;
        return (
          <button
            key={tab.id}
            data-tabid={tab.id}
            style={{ width: SLOT }}
            className={slotClass(tab.id, activeId === tab.id)}
            draggable
            onDragStart={(e) => { setDrag(tab.id); e.dataTransfer.effectAllowed = "move"; }}
            onDragOver={(e) => { e.preventDefault(); setDrop(tab.id); }}
            onDrop={(e) => { e.preventDefault(); commit(tab.id); }}
            onDragEnd={resetDrag}
            onClick={() => onSelect(tab.id)}
            onTouchStart={(e) => {
              touchStart.current = { x: e.touches[0]!.clientX, y: e.touches[0]!.clientY };
              clearPress();
              pressTimer.current = setTimeout(() => setDrag(tab.id), LONG_PRESS_MS);
            }}
            onTouchMove={(e) => {
              // Pre-arm only: a scroll/tap that moves before long-press fires cancels the drag arm.
              if (!dragRef.current && touchStart.current) {
                const dx = Math.abs(e.touches[0]!.clientX - touchStart.current.x);
                const dy = Math.abs(e.touches[0]!.clientY - touchStart.current.y);
                if (dx > DRAG_CANCEL_PX || dy > DRAG_CANCEL_PX) clearPress();
              }
            }}
            onTouchEnd={() => {
              clearPress();
              if (dragRef.current && dropRef.current) commit(dropRef.current);
              else resetDrag();
              touchStart.current = null;
            }}
          >
            <Icon className="size-4" />
            <span>{tab.shortLabel ?? tab.label}</span>
          </button>
        );
      })}

      {needMore && (
        <button
          style={{ width: SLOT }}
          onClick={() => setMoreOpen(true)}
          className={cn(
            "flex flex-col items-center justify-center gap-0.5 shrink-0 py-2.5 text-[10px] transition-colors",
            activeInOverflow ? "text-primary" : "text-text-secondary",
          )}
        >
          <MoreHorizontal className="size-4" />
          <span>More</span>
        </button>
      )}

      <BottomSheet open={moreOpen} onClose={() => setMoreOpen(false)}>
        <div className="px-2 pb-3 pt-1">
          <div className="px-2 py-1 text-xs text-text-secondary">More tabs</div>
          {overflow.map((tab) => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                onClick={() => { onSelect(tab.id); setMoreOpen(false); }}
                className={cn(
                  "flex items-center gap-3 w-full px-3 py-2.5 rounded-md text-sm active:bg-surface-elevated",
                  activeId === tab.id ? "text-primary" : "text-foreground",
                )}
              >
                <Icon className="size-4 shrink-0" />
                <span>{tab.label}</span>
              </button>
            );
          })}
        </div>
      </BottomSheet>
    </div>
  );
}
