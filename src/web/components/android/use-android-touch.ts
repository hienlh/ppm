/**
 * Pointer events on the canvas -> `sendTouch` messages.
 *
 * Five things that are not optional:
 *
 *  - **`touch-action: none`** on the canvas, or the browser eats the gesture as a scroll or a
 *    pinch and the guest sees a fraction of it. Set in the viewer's class list, not here.
 *  - **Pointer capture**, so a drag that leaves the canvas keeps reporting. Without it a swipe
 *    off the edge simply stops, and the finger is never released.
 *  - **Every active contact is sent on every update.** The emulator tracks slots by identifier
 *    and a message describing only the finger that moved would be read as the others lifting.
 *  - **A release is pressure 0, and it must be sent.** The proto is explicit: "Make sure to
 *    deliver a pressure of 0 for the given identifier when the touch event is completed,
 *    otherwise the touch identifier will not be unregistered". The 120-second expiry is not a
 *    substitute.
 *  - **`pointercancel` is handled exactly like `pointerup`.** The browser fires it instead of
 *    `pointerup` once it decides a gesture belongs to something else, and then delivers nothing
 *    further for that pointer — the same class of bug as the long-press trap in CLAUDE.md, only
 *    here it leaves a finger pressed on the guest forever.
 */
import { useCallback, useEffect, useRef } from "react";
import { pointerToDevice } from "./android-coords";
import type { AndroidClientMessage, AndroidGeometry, AndroidTouchPoint } from "../../../shared/android-protocol";

/** What the emulator reports for a finger that is down. Any non-zero value means "touching". */
const PRESSURE_DOWN = 1;
const MAX_SLOTS = 10;

export interface UseAndroidTouchOptions {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  geometry: AndroidGeometry | null;
  enabled: boolean;
  send: (message: AndroidClientMessage) => void;
}

export interface AndroidTouchHandlers {
  onPointerDown: (e: React.PointerEvent<HTMLCanvasElement>) => void;
  onPointerMove: (e: React.PointerEvent<HTMLCanvasElement>) => void;
  onPointerUp: (e: React.PointerEvent<HTMLCanvasElement>) => void;
  onPointerCancel: (e: React.PointerEvent<HTMLCanvasElement>) => void;
}

export function useAndroidTouch(opts: UseAndroidTouchOptions): AndroidTouchHandlers {
  const { canvasRef, geometry, enabled, send } = opts;

  /** Browser pointerId -> the emulator slot it owns, plus its last position. */
  const contacts = useRef(new Map<number, { slot: number; x: number; y: number }>());

  const geometryRef = useRef(geometry);
  geometryRef.current = geometry;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const publish = useCallback((releasing?: { slot: number; x: number; y: number }) => {
    const g = geometryRef.current;
    if (!g) return;
    const touches: AndroidTouchPoint[] = [...contacts.current.values()].map((c) => ({
      x: c.x, y: c.y, id: c.slot, pressure: PRESSURE_DOWN,
    }));
    if (releasing) touches.push({ x: releasing.x, y: releasing.y, id: releasing.slot, pressure: 0 });
    if (touches.length === 0) return;
    send({ type: "touch", geometryGeneration: g.generation, touches });
  }, [send]);

  const locate = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    const g = geometryRef.current;
    if (!canvas || !g) return null;
    const rect = canvas.getBoundingClientRect();
    return pointerToDevice(rect, g, e.clientX - rect.left, e.clientY - rect.top);
  }, [canvasRef]);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!enabledRef.current) return;
    const point = locate(e);
    if (!point) return;              // a letterbox bar belongs to no pixel of the guest
    if (contacts.current.size >= MAX_SLOTS) return;
    const used = new Set([...contacts.current.values()].map((c) => c.slot));
    let slot = 0;
    while (used.has(slot)) slot++;
    contacts.current.set(e.pointerId, { slot, x: point.x, y: point.y });
    // Capture, so a drag that leaves the canvas keeps reporting and can still be released.
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
    publish();
  }, [locate, publish]);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const contact = contacts.current.get(e.pointerId);
    if (!contact || !enabledRef.current) return;
    const point = locate(e);
    // Outside the picture the finger keeps its last position rather than jumping or lifting: a
    // swipe that overshoots the edge is still one continuous gesture to the guest.
    if (point) { contact.x = point.x; contact.y = point.y; }
    publish();
  }, [locate, publish]);

  const release = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const contact = contacts.current.get(e.pointerId);
    if (!contact) return;
    contacts.current.delete(e.pointerId);
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    publish(contact);
  }, [publish]);

  // A tab hidden or a window blurred mid-drag delivers no further pointer events at all, so the
  // only way the guest ever sees those fingers lift is for the server to clear every slot.
  useEffect(() => {
    const reset = () => {
      if (contacts.current.size === 0) return;
      contacts.current.clear();
      send({ type: "input-reset" });
    };
    window.addEventListener("blur", reset);
    document.addEventListener("visibilitychange", reset);
    return () => {
      window.removeEventListener("blur", reset);
      document.removeEventListener("visibilitychange", reset);
      reset();
    };
  }, [send]);

  return { onPointerDown, onPointerMove, onPointerUp: release, onPointerCancel: release };
}
