/**
 * The payload of the drag currently in flight, kept in a module-level ref.
 *
 * Chromium refuses to read `dataTransfer` during `dragover` (only `types` is exposed, for
 * privacy), so a drop target that has to decide "is this folder one of the dragged ones?"
 * before the drop cannot get the paths from the event. Every drag in this app starts in
 * this app, so stashing the payload here at `dragstart` and clearing it at `dragend` gives
 * hover-time validation without weakening the drop-time check, which still reads the real
 * `dataTransfer`.
 */

import type { EntryDragPayload } from "./entry-drag-payload";

let inFlight: EntryDragPayload | null = null;

export function setInFlightDrag(payload: EntryDragPayload): void {
  inFlight = payload;
}

export function getInFlightDrag(): EntryDragPayload | null {
  return inFlight;
}

export function clearInFlightDrag(): void {
  inFlight = null;
}
