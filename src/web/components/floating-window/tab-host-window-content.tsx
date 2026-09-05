/**
 * Floating-window body that hosts a detached tab.
 *
 * It renders no tab of its own: it publishes a TabPool slot, and TabPool moves the tab's
 * live DOM node into it. That is the whole point — the terminal keeps its PTY, the editor
 * its undo stack, the chat its stream, because nothing remounts.
 *
 * Picture-in-picture is not handled here: the frame publishes its own body element as the
 * PiP slot and owns the placeholder, so this file only has to hand the tab back when it
 * goes away.
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

  // Re-dock when this body goes away. Every close path (titlebar ×, keyboard, a
  // programmatic close, the window layer unmounting below the desktop breakpoint) unmounts
  // this body, so they all route through here. The frame's own layout cleanup has already
  // taken the body out of any PiP document by this point — React destroys a parent's layout
  // effects before its children's — so the tab is back in the main document to be moved.
  //
  // The hand-back is deferred by one microtask on purpose: React StrictMode (and Offscreen /
  // Activity subtrees) run a layout cleanup and then immediately re-run the setup on the
  // SAME instance. Re-docking synchronously in that simulated cleanup pulled the tab back
  // to the grid a moment after every pop-out and left the window empty. A re-run setup
  // cancels the pending hand-back; a real unmount has no re-run, so the microtask fires.
  // Deferring is safe for the DOM: React only detaches this body's root node, the slot and
  // the tab inside it stay intact until the microtask runs.
  const pendingRedock = useRef<object | null>(null);
  useLayoutEffect(() => {
    pendingRedock.current = null;
    return () => {
      const token = {};
      pendingRedock.current = token;
      queueMicrotask(() => {
        if (pendingRedock.current !== token) return;
        pendingRedock.current = null;
        usePanelStore.getState().redockFromWindow(id, originRef.current);
      });
    };
  }, [id]);

  return (
    <div className="relative h-full w-full">
      {/* Always mounted, never swapped for a placeholder: the slot may currently hold a
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
