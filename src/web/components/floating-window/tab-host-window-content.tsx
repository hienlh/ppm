/**
 * Floating-window body that hosts a detached tab.
 *
 * It renders no tab of its own: it publishes a slot, and TabPool moves the tab's live DOM
 * node into it. That is the whole point — the terminal keeps its PTY, the editor its undo
 * stack, the chat its stream, because nothing remounts.
 */
import { useCallback, useLayoutEffect, useRef } from "react";
import { usePanelStore } from "@/stores/panel-store";
import { windowPanelId } from "@/stores/panel-utils";
import { registerPanelSlot } from "@/components/layout/tab-pool";
import type { WindowContentProps } from "./window-content-registry";

export default function TabHostWindowContent({ id, payload }: WindowContentProps) {
  // Derived, never passed in: the window id is minted by the store's open() call, so the
  // panel id cannot exist before the window does.
  const panelId = windowPanelId(id);
  const panel = usePanelStore((s) => s.panels[panelId]);
  const hasTabs = (panel?.tabs.length ?? 0) > 0;

  // A window restored from a previous session exists before the project layout finishes
  // loading. Remembering that a tab was once here keeps the placeholder from flashing
  // back when the tab is legitimately on its way out.
  const everHadTabs = useRef(false);
  if (hasTabs) everHadTabs.current = true;

  const originPanelId = typeof payload?.originPanelId === "string" ? payload.originPanelId : null;
  const originRef = useRef(originPanelId);
  originRef.current = originPanelId;

  const slotRef = useCallback(
    (el: HTMLDivElement | null) => registerPanelSlot(panelId, el),
    [panelId],
  );

  // Re-dock on unmount, from a LAYOUT cleanup: React runs those before it removes the
  // host nodes, while a passive cleanup runs after — too late to hand the tab back, and
  // fatal once the slot has been moved into another document. Every close path (titlebar
  // ×, keyboard, a programmatic close) unmounts this body, so they all route through here.
  useLayoutEffect(() => {
    return () => {
      usePanelStore.getState().redockFromWindow(id, originRef.current);
    };
  }, [id]);

  return (
    <div className="relative h-full w-full">
      {/* Always mounted, never swapped for the placeholder: the slot may currently hold a
          reparented tab (or live in another document), and unmounting it would make React
          remove a node whose parent is no longer this tree. */}
      <div ref={slotRef} className="absolute inset-0" />
      {!hasTabs && !everHadTabs.current && (
        <div className="absolute inset-0 flex items-center justify-center text-xs text-text-2 pointer-events-none">
          Loading…
        </div>
      )}
    </div>
  );
}
