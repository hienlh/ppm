/**
 * Forwards keydown/keyup from a hidden `<input>` to the shared connection, so a toolbar
 * "Keyboard" button can bring up the phone's soft keyboard without a physical keyboard ever
 * being attached. Mirrors `use-remote-input-capture.ts`'s key handling exactly: `code`
 * (physical key, layout-independent) is sent, never `key` — the host maps `code` → VK.
 */
import { useEffect, useRef, useCallback } from "react";

export interface UseRemoteDesktopVirtualKeyboardResult {
  inputRef: React.RefObject<HTMLInputElement | null>;
  /** Focus the hidden input, which brings up the soft keyboard on a touch device. */
  show: () => void;
}

export function useRemoteDesktopVirtualKeyboard(
  sendMessage: (msg: Record<string, unknown>) => void,
  enabled: boolean,
): UseRemoteDesktopVirtualKeyboardResult {
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const input = inputRef.current;
    if (!input || !enabled) return;

    // A lost keyup (blur, tab hidden, WS drop) must not leave a modifier logically held on the
    // host — force a release on every path that could lose the matching keyup.
    const releaseAll = () => sendMessage({ type: "releaseAll" });
    const onKeyDown = (e: KeyboardEvent) => { e.preventDefault(); sendMessage({ type: "key", code: e.code, down: true }); };
    const onKeyUp = (e: KeyboardEvent) => { e.preventDefault(); sendMessage({ type: "key", code: e.code, down: false }); };
    const onBlur = () => releaseAll();
    const onVisibilityChange = () => { if (document.hidden) releaseAll(); };

    input.addEventListener("keydown", onKeyDown);
    input.addEventListener("keyup", onKeyUp);
    input.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      input.removeEventListener("keydown", onKeyDown);
      input.removeEventListener("keyup", onKeyUp);
      input.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      releaseAll();
    };
  }, [enabled, sendMessage]);

  const show = useCallback(() => inputRef.current?.focus(), []);

  return { inputRef, show };
}
