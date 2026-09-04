/**
 * Moves an existing DOM subtree (a TabPool panel slot) into a Document
 * Picture-in-Picture window and puts it back.
 *
 * The slot is *moved*, never cloned or remounted: TabPool keeps moving its tab
 * wrapper into whatever element is registered for that panel id, so moving the
 * slot itself leaves that invariant intact and needs no store awareness here.
 * This module imports no store.
 */

import { documentPipApi } from "./pip-support";
import { clampPipSize } from "./pip-geometry";
import { copyDocumentStyles, syncThemeToPip, watchStyleInjection } from "./pip-style-copy";
import { forwardKeyEvents } from "./pip-key-forward";
import { signalHostResize } from "./pip-resize-signal";

export interface PipHostOptions {
  /** Requested inner size in CSS px; clamped by clampPipSize(). */
  width: number;
  height: number;
  /** Called after the slot has been restored, for any reason (user close, replacement, error). */
  onDetach(): void;
}

export interface PipHandle {
  detach(): void;
  readonly pipWindow: Window;
}

/** One PiP window per page — the browser allows no more. */
let activeHandle: PipHandle | null = null;

/** The host currently holding a slot, or null. */
export function activePipHost(): PipHandle | null {
  return activeHandle;
}

function setUpHost(
  slotEl: HTMLElement,
  origin: HTMLElement,
  pipWindow: Window,
  opts: PipHostOptions,
): PipHandle {
  const disposers: Array<() => void> = [];
  let detached = false;

  const restore = () => {
    if (detached) return;
    detached = true;
    if (activeHandle === handle) activeHandle = null;
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        // Keep tearing down — a failed disposer must not strand the slot.
      }
    }
    // Synchronous on purpose: letting the PiP document close with the subtree
    // still inside strips every DOM listener in it recursively, which kills a
    // live terminal for good. No await, no rAF between here and the move.
    if (origin.isConnected) {
      origin.append(slotEl);
      signalHostResize(slotEl);
    }
    try {
      pipWindow.close();
    } catch {
      // Already closing.
    }
    opts.onDetach();
  };

  const handle: PipHandle = { detach: restore, pipWindow };

  try {
    const doc = pipWindow.document;
    copyDocumentStyles(document, doc);
    disposers.push(syncThemeToPip(document, doc));
    disposers.push(watchStyleInjection(document, doc));

    doc.body.append(slotEl);
    signalHostResize(slotEl);

    // The PiP window's own resize fires immediately, unlike the main window's
    // ResizeObservers for a PiP-driven size.
    const onPipResize = () => signalHostResize(slotEl);
    pipWindow.addEventListener("resize", onPipResize);
    disposers.push(() => pipWindow.removeEventListener("resize", onPipResize));

    pipWindow.addEventListener("pagehide", restore);
    disposers.push(() => pipWindow.removeEventListener("pagehide", restore));

    disposers.push(forwardKeyEvents(pipWindow, window));

    // The main window going away must not leave the slot in a dying document.
    window.addEventListener("pagehide", restore);
    window.addEventListener("beforeunload", restore);
    disposers.push(() => {
      window.removeEventListener("pagehide", restore);
      window.removeEventListener("beforeunload", restore);
    });
  } catch (err) {
    restore();
    throw err;
  }

  return handle;
}

/**
 * Open a PiP window and move `slotEl` into it.
 *
 * `requestWindow()` needs transient activation, and it is the first async call
 * here — call this synchronously from a click handler, with nothing awaited
 * before it.
 */
export async function attachPipHost(slotEl: HTMLElement, opts: PipHostOptions): Promise<PipHandle> {
  const api = documentPipApi();
  if (!api) throw new Error("Document Picture-in-Picture is not supported in this browser");
  const origin = slotEl.parentElement;
  if (!origin) throw new Error("attachPipHost: slot element must be in the document");

  // One PiP at a time: the previous tab goes back to its floating window first.
  activeHandle?.detach();

  const pipWindow = await api.requestWindow(clampPipSize({ width: opts.width, height: opts.height }));
  const handle = setUpHost(slotEl, origin, pipWindow, opts);
  activeHandle = handle;
  return handle;
}
