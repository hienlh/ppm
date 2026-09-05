/**
 * The body element every floating window renders its content into, and its picture-in-picture
 * lifecycle. Owned by the frame, so PiP is a capability of the window rather than of any one
 * kind.
 *
 * The element is created imperatively and never re-created, and the content reaches it
 * through a portal. That is what makes it portable: React attaches its delegated listeners
 * to a portal container, and they travel with the node into another document — a normally
 * rendered subtree goes dead (no clicks, no menus) the moment it is moved into a PiP
 * document.
 */

import { useLayoutEffect, useState, type RefObject } from "react";
import { activePipHost, type PipHandle } from "./pip/pip-host";
import { publishWindowSlot, useWindowPip, windowPip } from "./window-pip-registry";

const BODY_CLASS = "relative flex-1 min-h-0 overflow-hidden rounded-b-[8px] bg-panel";

export interface WindowBodyElement {
  /** Portal target for the window's content. */
  body: HTMLElement;
  /** The PiP handle this window's body currently lives in, or null. */
  pip: PipHandle | null;
}

export function useWindowBodyElement(
  windowId: string,
  rootRef: RefObject<HTMLElement | null>,
  minimized: boolean,
): WindowBodyElement {
  const pip = useWindowPip(windowId);
  const [body] = useState(() => {
    const el = document.createElement("div");
    el.className = BODY_CLASS;
    return el;
  });

  // Mount the body and publish it as this window's PiP slot.
  //
  // The cleanup is the window's teardown order, and it must run BEFORE the content's own
  // cleanups: React destroys a parent's layout effects before its children's when a subtree
  // is deleted (commitDeletionEffectsOnFiber runs the fiber's own destroys, then recurses
  // into children). So PiP is detached — moving the body out of a document about to close —
  // while the content below is still mounted, and a tab-host body's deferred re-dock still
  // gets to run afterwards on a subtree that is back in the main document.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    root.append(body);
    publishWindowSlot(windowId, body);
    return () => {
      const handle = windowPip(windowId);
      if (handle && activePipHost() === handle) handle.detach();
      publishWindowSlot(windowId, null);
      body.remove();
    };
  }, [body, rootRef, windowId]);

  // Minimising hides the body via CSS rather than unmounting it — content owns per-window
  // state (explorer history, selection, filter) that a remount would wipe. Never while PiP
  // is active: the body is in the PiP document then, and `hidden` would blank it there.
  useLayoutEffect(() => {
    body.classList.toggle("hidden", minimized && !pip);
  }, [body, minimized, pip]);

  return { body, pip };
}
