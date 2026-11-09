/**
 * ReparentingTab — one tab component, mounted once, physically moved between panel slots.
 *
 * The wrapper element is created imperatively and never re-created, and the tab renders
 * into it through a portal. That is what makes the node portable: React attaches its
 * event listeners to the portal container itself, so they keep working after the wrapper
 * is moved into a panel slot — including a slot that lives in another document, where
 * the app root's delegated listeners would never match.
 *
 * The wrapper's placement is owned here (hidden container ⇄ slot); its children are owned
 * by React. Nothing outside may re-create the wrapper: a new container element would
 * remount the tab and destroy exactly the state (xterm buffer, Monaco undo stack, chat
 * scroll) this component exists to preserve.
 */
import { useLayoutEffect, useRef, Suspense, type ComponentType } from "react";
import { createPortal } from "react-dom";
import { Loader2 } from "@/lib/icons";
import { usePanelStore } from "@/stores/panel-store";
import { DOCK_PANEL_ID, isWindowPanelId } from "@/stores/panel-utils";
import { PortalContainerProvider } from "@/components/ui/portal-container-context";
import { usePipPortalContainer } from "@/components/floating-window/window-pip-registry";
import { slotRegistry } from "./tab-pool-registry";

export interface ReparentingTabProps {
  tabId: string;
  panelId: string;
  component: ComponentType<{ metadata?: Record<string, unknown>; tabId?: string }>;
  metadata?: Record<string, unknown>;
  isActive: boolean;
  /** Off-screen parent the wrapper lives in whenever its panel has no slot mounted. */
  hiddenContainer: HTMLDivElement;
}

export function ReparentingTab({
  tabId,
  panelId,
  component: Component,
  metadata,
  isActive,
  hiddenContainer,
}: ReparentingTabProps) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  if (!wrapperRef.current) {
    const el = document.createElement("div");
    el.className = "absolute inset-0";
    el.dataset.tabPoolId = tabId;
    wrapperRef.current = el;
  }
  const wrapper = wrapperRef.current;

  // Written during render, before any effect, so the click listener below always reads
  // the panel the tab lives in NOW — a re-docked tab must focus its new panel.
  const panelIdRef = useRef(panelId);
  panelIdRef.current = panelId;

  // Where each scroller in the tab last stood, as its own scroll events said. A move resets
  // every offset, and on a project switch the old panel unmounts first, taking the wrapper off
  // the page before the move below runs — too late to read them then. A chat came back at its
  // top, and its history loader took that for the reader scrolling up and fetched another page
  // on every switch back.
  // Held weakly: a scroller React removed would keep its whole tree alive, and a chat replaces
  // its transcript's on every session switch.
  const scrolledRef = useRef(new WeakMap<Element, { top: number; left: number }>());
  /** The keys of `scrolledRef`, which a WeakMap cannot list. */
  const scrollersRef = useRef(new Set<WeakRef<Element>>());
  /** Moved while hidden, when there was no layout to put the offsets back into. */
  const restorePendingRef = useRef(false);
  const restoreScroll = () => {
    for (const ref of scrollersRef.current) {
      const el = ref.deref();
      const at = el && scrolledRef.current.get(el);
      if (!el || !at || !wrapper.contains(el)) {
        scrollersRef.current.delete(ref);
        if (el) scrolledRef.current.delete(el);
        continue;
      }
      el.scrollTop = at.top;
      el.scrollLeft = at.left;
    }
  };

  // Mount the wrapper and own its removal. The listener is native and capturing because
  // the tab content is DOM-reparented out of the panel's fiber subtree: the panel never
  // sees clicks on the content body, so focus is set here, where the panel is known.
  useLayoutEffect(() => {
    if (!wrapper.parentElement) hiddenContainer.appendChild(wrapper);
    const onMouseDown = () => {
      const pid = panelIdRef.current;
      // Off-grid panels are skipped: focus decides where the next tab opens, and it may
      // never land in the dock or inside a floating window.
      if (pid === DOCK_PANEL_ID || isWindowPanelId(pid)) return;
      usePanelStore.getState().setFocusedPanel(pid);
    };
    const scrolled = scrolledRef.current;
    const scrollers = scrollersRef.current;
    const onScroll = (e: Event) => {
      // Parked out of sight a scroller has no size, and whatever moves it there is not the reader.
      if (wrapper.parentElement === hiddenContainer) return;
      const el = e.target as Element;
      if (el.nodeType !== Node.ELEMENT_NODE) return;
      if (!scrolled.has(el)) {
        for (const ref of scrollers) if (!ref.deref()) scrollers.delete(ref);
        scrollers.add(new WeakRef(el));
      }
      scrolled.set(el, { top: el.scrollTop, left: el.scrollLeft });
    };
    wrapper.addEventListener("pointerdown", onMouseDown, true);
    wrapper.addEventListener("focusin", onMouseDown, true);
    wrapper.addEventListener("scroll", onScroll, true);
    return () => {
      wrapper.removeEventListener("pointerdown", onMouseDown, true);
      wrapper.removeEventListener("focusin", onMouseDown, true);
      wrapper.removeEventListener("scroll", onScroll, true);
      wrapper.remove();
    };
  }, [wrapper, hiddenContainer]);

  useLayoutEffect(() => {
    wrapper.style.display = isActive ? "" : "none";
    // Only for a tab moved while hidden: a plain tab switch keeps its offsets, and writing them
    // back forces a layout of the whole tab in the middle of the commit.
    if (isActive && restorePendingRef.current) {
      restorePendingRef.current = false;
      restoreScroll();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wrapper, isActive]);

  // Imperatively move the wrapper into the correct panel slot.
  // appendChild on an already-mounted node moves it (DOM spec — no clone/destroy).
  // useLayoutEffect runs before paint, so the user never sees the off-screen state.
  // No deps — must run every render because React's reconciliation may call
  // insertBefore() to reorder keyed children, moving reparented nodes back
  // to the hidden container. The early-return guard keeps this cheap.
  useLayoutEffect(() => {
    const slot = slotRegistry.get(panelId);

    // Panel slot not mounted (e.g., mobile renders only the focused panel).
    // Move wrapper back to hidden container so it doesn't overlap in the wrong slot.
    if (!slot) {
      if (wrapper.parentElement !== hiddenContainer) hiddenContainer.appendChild(wrapper);
      return;
    }

    if (wrapper.parentElement === slot) return;

    slot.appendChild(wrapper);
    // Before paint, from what the scroll events recorded: walking every element of the tab
    // to read offsets cost a whole transcript's worth of reads per move, and read zeros
    // whenever the wrapper had already left the page.
    restorePendingRef.current = !isActive;
    if (isActive) restoreScroll();
  });

  // Portal target for the tab's own dropdowns, tooltips and sheets. It belongs here and
  // not in the floating-window body: the wrapper's React parent is this component, so a
  // provider mounted around the window body would never reach the tab's primitives, and
  // a menu opened in a picture-in-picture window would render in the main one — off
  // screen, unreachable, and stealing the click. `undefined` while docked, which is the
  // document default.
  const portalContainer = usePipPortalContainer(panelId);

  return createPortal(
    <PortalContainerProvider container={portalContainer}>
      <Suspense
        fallback={
          <div className="flex items-center justify-center h-full">
            <Loader2 className="size-6 animate-spin text-primary" />
          </div>
        }
      >
        <Component metadata={metadata} tabId={tabId} />
      </Suspense>
    </PortalContainerProvider>,
    wrapper,
  );
}
