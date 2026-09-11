/**
 * `KeyboardEvent.code` (physical key, layout-independent) → Linux evdev key code
 * (`KEY_*` from `linux/input-event-codes.h`). Same contract as `remote-desktop-vk-map.ts`
 * and `remote-desktop-cg-key-map.ts`: only `code` is accepted, never `key`.
 *
 * Evdev codes rather than X11 keysyms, and that choice is what makes this table correct on a
 * non-US host. `XKeysymToKeycode(XK_a)` answers "which key currently *produces* an a", which
 * on an AZERTY host is the physical Q key — so a keysym table would silently transpose the
 * whole keyboard for anyone not on a US layout. An evdev code names the physical switch, which
 * is exactly what `KeyboardEvent.code` also names, so the mapping is a rename rather than a
 * lookup through the active layout.
 *
 * The same table serves both Linux backends: XTEST wants `evdev + 8` (see `X11_KEYCODE_OFFSET`)
 * and uinput wants the raw code.
 */

const CODE_TO_EVDEV: Record<string, number> = {
  Escape: 1,
  Digit1: 2, Digit2: 3, Digit3: 4, Digit4: 5, Digit5: 6,
  Digit6: 7, Digit7: 8, Digit8: 9, Digit9: 10, Digit0: 11,
  Minus: 12, Equal: 13, Backspace: 14, Tab: 15,
  KeyQ: 16, KeyW: 17, KeyE: 18, KeyR: 19, KeyT: 20, KeyY: 21,
  KeyU: 22, KeyI: 23, KeyO: 24, KeyP: 25,
  BracketLeft: 26, BracketRight: 27, Enter: 28, ControlLeft: 29,
  KeyA: 30, KeyS: 31, KeyD: 32, KeyF: 33, KeyG: 34,
  KeyH: 35, KeyJ: 36, KeyK: 37, KeyL: 38,
  Semicolon: 39, Quote: 40, Backquote: 41, ShiftLeft: 42, Backslash: 43,
  KeyZ: 44, KeyX: 45, KeyC: 46, KeyV: 47, KeyB: 48, KeyN: 49, KeyM: 50,
  Comma: 51, Period: 52, Slash: 53, ShiftRight: 54,
  NumpadMultiply: 55, AltLeft: 56, Space: 57, CapsLock: 58,
  F1: 59, F2: 60, F3: 61, F4: 62, F5: 63, F6: 64, F7: 65, F8: 66, F9: 67, F10: 68,
  NumLock: 69, ScrollLock: 70,
  Numpad7: 71, Numpad8: 72, Numpad9: 73, NumpadSubtract: 74,
  Numpad4: 75, Numpad5: 76, Numpad6: 77, NumpadAdd: 78,
  Numpad1: 79, Numpad2: 80, Numpad3: 81, Numpad0: 82, NumpadDecimal: 83,
  /** The extra key ISO layouts have next to the left Shift (`KEY_102ND`). */
  IntlBackslash: 86,
  F11: 87, F12: 88,
  /** Japanese layouts (`KEY_RO`, `KEY_YEN`). */
  IntlRo: 89,
  NumpadEnter: 96, ControlRight: 97, NumpadDivide: 98,
  PrintScreen: 99, AltRight: 100,
  Home: 102, ArrowUp: 103, PageUp: 104, ArrowLeft: 105, ArrowRight: 106,
  End: 107, ArrowDown: 108, PageDown: 109, Insert: 110, Delete: 111,
  Pause: 119,
  IntlYen: 124,
  MetaLeft: 125, MetaRight: 126, ContextMenu: 127,
  F13: 183, F14: 184, F15: 185, F16: 186, F17: 187, F18: 188,
  F19: 189, F20: 190, F21: 191, F22: 192, F23: 193, F24: 194,
};

/** X11 keycodes are evdev codes shifted by 8 — an XFree86 legacy that every Linux X server
 *  still honours (verified against a live server: `KEY_A` 30 → X keycode 38, `KEY_ESC` 1 → 9,
 *  `KEY_LEFTMETA` 125 → 133). */
export const X11_KEYCODE_OFFSET = 8;

/** Every modifier's evdev code — used to force-release stuck modifiers on teardown (a lost
 *  keyup otherwise leaves e.g. Shift logically held on the host after the WS drops). */
export const MODIFIER_EVDEV_CODES = [42, 54, 29, 97, 56, 100, 125, 126] as const;

/** Every code this table can emit. A uinput device must declare each key it will ever send
 *  (`UI_SET_KEYBIT`) before creation — an undeclared key is dropped by the kernel silently. */
export const ALL_EVDEV_CODES: readonly number[] = [...new Set(Object.values(CODE_TO_EVDEV))].sort((a, b) => a - b);

/** Resolve a `KeyboardEvent.code` to its evdev code; null for anything unmapped (IME
 *  composition, media keys) rather than guessing and injecting the wrong key. */
export function codeToEvdev(code: string): number | null {
  return CODE_TO_EVDEV[code] ?? null;
}
