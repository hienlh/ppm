/**
 * Resize signal for tabs whose host document changed size.
 *
 * Main-window `ResizeObserver`s are late (xterm: seconds) or silent (Monaco
 * `automaticLayout`) for sizes driven by a PiP window, so the host tells the
 * tabs directly instead of waiting for an observer.
 *
 * The event does NOT bubble: it is dispatched on every tab wrapper inside the
 * slot, and the slot is an *ancestor* of those wrappers — an upward-bubbling
 * event dispatched on the slot would never reach them.
 */

export const HOST_RESIZE_EVENT = "ppm:host-resize";

/** Tell every tab inside `slotEl` that its host size changed. */
export function signalHostResize(slotEl: Element | null | undefined): void {
  if (!slotEl) return;
  for (const wrapper of slotEl.querySelectorAll("[data-tab-pool-id]")) {
    wrapper.dispatchEvent(new CustomEvent(HOST_RESIZE_EVENT, { bubbles: false }));
  }
}

/**
 * Subscribe a tab surface to the signal. `containerEl` is any node inside the
 * tab; the listener lands on its `[data-tab-pool-id]` wrapper. Returns an
 * unsubscribe (a no-op when the element is not inside a pooled tab).
 */
export function onHostResize(containerEl: Element | null | undefined, handler: () => void): () => void {
  const wrapper = containerEl?.closest("[data-tab-pool-id]");
  if (!wrapper) return () => {};
  wrapper.addEventListener(HOST_RESIZE_EVENT, handler);
  return () => wrapper.removeEventListener(HOST_RESIZE_EVENT, handler);
}
