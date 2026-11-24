/**
 * Mouse, pen, touch, wheel and keyboard of the viewer → messages for the page.
 *
 * Pointer events cover all three pointer kinds: a mouse or pen becomes `pointer`, a finger
 * becomes `touch`, so a phone gets the page's own touch handling (scroll, pinch, long-press)
 * while a touchscreen laptop still clicks.
 *
 * Keys and text go through a hidden `<textarea>` laid over the picture and focused on every
 * tap: an IME composes only into a focused text field, so a canvas alone could never receive
 * Vietnamese. Its value is cleared after each message so nothing accumulates in it.
 */
import { useEffect, useRef } from "react";
import type { WebBrowserClientMessage } from "../../../shared/web-browser-protocol";
import { fractionFromPoint } from "@/components/remote-desktop/remote-desktop-coords";
import { beforeInputMessages, isCopyKey, keyMessage } from "@/lib/web-browser/web-browser-keyboard";

type Send = (msg: WebBrowserClientMessage) => void;

export interface WebBrowserInputOptions {
  enabled: boolean;
  send: Send;
  /** Called after Ctrl/Cmd+C or X reached the page, to fetch what it copied. */
  onCopy: () => void;
  onPasteText: (text: string) => void;
}

const BUTTONS = ["left", "middle", "right"] as const;

export function useWebBrowserInput(
  surfaceRef: React.RefObject<HTMLElement | null>,
  fieldRef: React.RefObject<HTMLTextAreaElement | null>,
  opts: WebBrowserInputOptions,
): void {
  const optsRef = useRef(opts);
  optsRef.current = opts;

  useEffect(() => {
    const surface = surfaceRef.current;
    const field = fieldRef.current;
    if (!surface || !field || !opts.enabled) return;
    const send = (m: WebBrowserClientMessage) => optsRef.current.send(m);
    const frac = (e: { clientX: number; clientY: number }) => fractionFromPoint(e.clientX, e.clientY, surface.getBoundingClientRect());
    const touches = new Map<number, { xFrac: number; yFrac: number }>();
    const touchList = () => [...touches].map(([id, p]) => ({ id, ...p }));

    const onPointerDown = (e: PointerEvent) => {
      field.focus({ preventScroll: true });
      surface.setPointerCapture?.(e.pointerId);
      if (e.pointerType === "touch") {
        touches.set(e.pointerId, frac(e));
        send({ type: "touch", phase: touches.size === 1 ? "start" : "move", points: touchList() });
      } else {
        send({ type: "pointer", ...frac(e), button: BUTTONS[e.button] ?? "left", down: true, clickCount: Math.min(3, Math.max(1, e.detail || 1)) });
      }
      e.preventDefault();
    };
    const onPointerMove = (e: PointerEvent) => {
      if (e.pointerType === "touch") {
        if (!touches.has(e.pointerId)) return;
        touches.set(e.pointerId, frac(e));
        send({ type: "touch", phase: "move", points: touchList() });
      } else {
        send({ type: "pointer", ...frac(e), button: "none", down: null });
      }
    };
    const onPointerUp = (e: PointerEvent) => {
      if (e.pointerType === "touch") {
        touches.delete(e.pointerId);
        send({ type: "touch", phase: e.type === "pointercancel" ? "cancel" : "end", points: touchList() });
        if (e.type === "pointercancel") touches.clear();
      } else {
        send({ type: "pointer", ...frac(e), button: BUTTONS[e.button] ?? "left", down: false, clickCount: Math.min(3, Math.max(1, e.detail || 1)) });
      }
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? surface.clientHeight : 1;
      send({ type: "wheel", ...frac(e), dx: e.deltaX * scale, dy: e.deltaY * scale });
    };
    const onContextMenu = (e: Event) => e.preventDefault();

    const onKey = (e: KeyboardEvent) => {
      const msg = keyMessage(e, e.type === "keydown");
      if (!msg) return;
      e.preventDefault();
      send(msg);
      if (e.type === "keydown" && isCopyKey(e)) setTimeout(() => optsRef.current.onCopy(), 120);
    };
    const onBeforeInput = (e: InputEvent) => {
      const msgs = beforeInputMessages(e.inputType, e.data);
      if (!msgs) return; // composition: compositionend sends it
      e.preventDefault();
      for (const m of msgs) send(m);
      field.value = "";
    };
    const onCompositionUpdate = (e: CompositionEvent) => {
      const text = e.data ?? "";
      send({ type: "compose", text, selStart: text.length, selEnd: text.length });
    };
    const onCompositionEnd = (e: CompositionEvent) => {
      if (e.data) send({ type: "text", text: e.data });
      else send({ type: "compose", text: "", selStart: 0, selEnd: 0 });
      field.value = "";
    };
    const onPaste = (e: ClipboardEvent) => {
      const text = e.clipboardData?.getData("text/plain");
      e.preventDefault();
      if (text) optsRef.current.onPasteText(text);
    };
    const onBlur = () => send({ type: "releaseAll" });

    surface.addEventListener("pointerdown", onPointerDown);
    surface.addEventListener("pointermove", onPointerMove);
    surface.addEventListener("pointerup", onPointerUp);
    surface.addEventListener("pointercancel", onPointerUp);
    surface.addEventListener("wheel", onWheel, { passive: false });
    surface.addEventListener("contextmenu", onContextMenu);
    field.addEventListener("keydown", onKey);
    field.addEventListener("keyup", onKey);
    field.addEventListener("beforeinput", onBeforeInput);
    field.addEventListener("compositionupdate", onCompositionUpdate);
    field.addEventListener("compositionend", onCompositionEnd);
    field.addEventListener("paste", onPaste);
    field.addEventListener("blur", onBlur);
    return () => {
      surface.removeEventListener("pointerdown", onPointerDown);
      surface.removeEventListener("pointermove", onPointerMove);
      surface.removeEventListener("pointerup", onPointerUp);
      surface.removeEventListener("pointercancel", onPointerUp);
      surface.removeEventListener("wheel", onWheel);
      surface.removeEventListener("contextmenu", onContextMenu);
      field.removeEventListener("keydown", onKey);
      field.removeEventListener("keyup", onKey);
      field.removeEventListener("beforeinput", onBeforeInput);
      field.removeEventListener("compositionupdate", onCompositionUpdate);
      field.removeEventListener("compositionend", onCompositionEnd);
      field.removeEventListener("paste", onPaste);
      field.removeEventListener("blur", onBlur);
    };
  }, [surfaceRef, fieldRef, opts.enabled]);
}
