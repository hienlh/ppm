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
import { activePipHost } from "./pip/pip-host";
import { publishTabHostSlot, tabHostPip, useTabHostPip } from "./tab-host-pip-registry";
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

  // The titlebar's PiP button needs this element and is a DOM sibling, not an ancestor,
  // so the slot is published by window id instead of passed down.
  const slotRef = useCallback(
    (el: HTMLDivElement | null) => {
      registerPanelSlot(panelId, el);
      publishTabHostSlot(id, el);
    },
    [panelId, id],
  );

  const pip = useTabHostPip(id);

  // Re-dock when this body goes away. Every close path (titlebar ×, keyboard, a
  // programmatic close, the window layer unmounting below the desktop breakpoint) unmounts
  // this body, so they all route through here.
  //
  // The hand-back is deferred by one microtask on purpose: React StrictMode (and Offscreen /
  // Activity subtrees) run a layout cleanup and then immediately re-run the setup on the
  // SAME instance. Re-docking synchronously in that simulated cleanup pulled the tab back
  // to the grid a moment after every pop-out and left the window empty. A re-run setup
  // cancels the pending hand-back; a real unmount has no re-run, so the microtask fires.
  // Deferring is safe for the DOM: React only detaches this body's root node, the slot and
  // the tab inside it stay intact (even inside a PiP document) until the microtask runs,
  // and the PiP host already tolerates a restore target that is no longer connected.
  const pendingRedock = useRef<object | null>(null);
  useLayoutEffect(() => {
    pendingRedock.current = null;
    return () => {
      const token = {};
      pendingRedock.current = token;
      queueMicrotask(() => {
        if (pendingRedock.current !== token) return;
        pendingRedock.current = null;
        // PiP first: detaching hands the slot back, and only then can the re-dock move the
        // tab out of it. The reverse order leaves the tab in a document about to close.
        const handle = tabHostPip(id);
        if (handle && activePipHost() === handle) handle.detach();
        publishTabHostSlot(id, null);
        usePanelStore.getState().redockFromWindow(id, originRef.current);
      });
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
      {/* While the slot lives in the PiP window this body would be an empty frame, which
          reads as a lost tab. The placeholder stays in the main document on purpose — it
          is the way back. */}
      {pip && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-panel text-center px-4">
          <span className="text-xs text-text-2">Playing in picture-in-picture</span>
          <button
            type="button"
            onClick={() => pip.detach()}
            className="min-h-11 min-w-11 px-4 rounded-md border border-border bg-surface-elevated text-sm text-text can-hover:hover:bg-panel-2 transition-colors"
          >
            Bring back
          </button>
        </div>
      )}
    </div>
  );
}
