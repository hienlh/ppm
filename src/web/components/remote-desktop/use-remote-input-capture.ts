/**
 * Captures pointer + keyboard on the canvas and forwards them as JSON over the caller's WS.
 * `code` (physical key, layout-independent) is sent for keys, never `key` — the host maps
 * `code` → VK, so a client-side layout mismatch can't inject the wrong character.
 */
import { useEffect, useCallback } from "react";
import { fractionFromPoint } from "./remote-desktop-coords";

type PointerButton = "left" | "right" | null;

export function useRemoteInputCapture(
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  sendMessage: (msg: Record<string, unknown>) => void,
  enabled: boolean,
): void {
  const sendPointer = useCallback((clientX: number, clientY: number, button: PointerButton, down: boolean | null) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const { xFrac, yFrac } = fractionFromPoint(clientX, clientY, canvas.getBoundingClientRect());
    sendMessage({ type: "pointer", xFrac, yFrac, button, down });
  }, [canvasRef, sendMessage]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !enabled) return;

    const toButton = (b: number): PointerButton => (b === 0 ? "left" : b === 2 ? "right" : null);
    // A lost keyup (blur, tab hidden, WS drop) must not leave a modifier logically held on
    // the host — force a release on every path that could lose the matching keyup.
    const releaseAll = () => sendMessage({ type: "releaseAll" });

    const onPointerDown = (e: PointerEvent) => {
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      canvas.focus();
      sendPointer(e.clientX, e.clientY, toButton(e.button), true);
    };
    const onPointerMove = (e: PointerEvent) => sendPointer(e.clientX, e.clientY, null, null);
    const onPointerUp = (e: PointerEvent) => sendPointer(e.clientX, e.clientY, toButton(e.button), false);
    const onContextMenu = (e: MouseEvent) => e.preventDefault();
    const onKeyDown = (e: KeyboardEvent) => { e.preventDefault(); sendMessage({ type: "key", code: e.code, down: true }); };
    const onKeyUp = (e: KeyboardEvent) => { e.preventDefault(); sendMessage({ type: "key", code: e.code, down: false }); };
    const onVisibilityChange = () => { if (document.hidden) releaseAll(); };

    canvas.tabIndex = 0; // focusable so it can receive keydown/keyup at all
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("contextmenu", onContextMenu);
    canvas.addEventListener("keydown", onKeyDown);
    canvas.addEventListener("keyup", onKeyUp);
    canvas.addEventListener("blur", releaseAll);
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("contextmenu", onContextMenu);
      canvas.removeEventListener("keydown", onKeyDown);
      canvas.removeEventListener("keyup", onKeyUp);
      canvas.removeEventListener("blur", releaseAll);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [canvasRef, enabled, sendPointer, sendMessage]);
}
