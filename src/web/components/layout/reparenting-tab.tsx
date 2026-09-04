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
import { useLayoutEffect, useRef, Suspense, type LazyExoticComponent, type ComponentType } from "react";
import { createPortal } from "react-dom";
import { Loader2 } from "lucide-react";
import { usePanelStore } from "@/stores/panel-store";
import { DOCK_PANEL_ID, isWindowPanelId } from "@/stores/panel-utils";
import { slotRegistry } from "./tab-pool-registry";

export interface ReparentingTabProps {
  tabId: string;
  panelId: string;
  component: LazyExoticComponent<ComponentType<{ metadata?: Record<string, unknown>; tabId?: string }>>;
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
    wrapper.addEventListener("mousedown", onMouseDown, true);
    return () => {
      wrapper.removeEventListener("mousedown", onMouseDown, true);
      wrapper.remove();
    };
  }, [wrapper, hiddenContainer]);

  useLayoutEffect(() => {
    wrapper.style.display = isActive ? "" : "none";
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

    // Save scroll positions — appendChild resets them during the DOM move
    const scrollables: { el: Element; top: number; left: number }[] = [];
    wrapper.querySelectorAll("*").forEach((el) => {
      if (el.scrollTop || el.scrollLeft) {
        scrollables.push({ el, top: el.scrollTop, left: el.scrollLeft });
      }
    });

    slot.appendChild(wrapper);

    // Restore scroll positions synchronously before paint
    for (const { el, top, left } of scrollables) {
      el.scrollTop = top;
      el.scrollLeft = left;
    }
  });

  return createPortal(
    <Suspense
      fallback={
        <div className="flex items-center justify-center h-full">
          <Loader2 className="size-6 animate-spin text-primary" />
        </div>
      }
    >
      <Component metadata={metadata} tabId={tabId} />
    </Suspense>,
    wrapper,
  );
}
