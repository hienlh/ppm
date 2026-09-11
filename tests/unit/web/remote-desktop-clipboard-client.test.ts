/**
 * The browser-side clipboard rules. These are pure predicates on purpose: the behaviour they
 * encode was measured in a real browser (`preventDefault()` on the Ctrl+V keydown cancels the
 * `paste` event outright, and Ctrl+Shift+V fires `paste` too) and neither fact is visible from
 * the code — so the tests state the *consequence* rather than re-deriving it.
 */
import { describe, it, expect } from "bun:test";
import {
  CLIPBOARD_READ_DELAY_MS, isCopyCombo, isPasteCombo,
} from "../../../src/web/components/remote-desktop/remote-desktop-clipboard-client";

const key = (code: string, mods: { ctrlKey?: boolean; metaKey?: boolean } = {}) =>
  ({ code, ctrlKey: false, metaKey: false, ...mods });

describe("isPasteCombo — the one key the capture must not preventDefault", () => {
  it("matches Ctrl+V and Cmd+V", () => {
    expect(isPasteCombo(key("KeyV", { ctrlKey: true }))).toBe(true);
    expect(isPasteCombo(key("KeyV", { metaKey: true }))).toBe(true);
  });

  it("matches Ctrl+Shift+V too, so a terminal's paste is not swallowed as a plain keystroke", () => {
    // Shift is *not* excluded here: Ctrl+Shift+V also fires `paste`, and the server is told to
    // press Ctrl+Shift+V rather than Ctrl+V (which a shell reads as a literal ^V).
    expect(isPasteCombo({ code: "KeyV", ctrlKey: true, metaKey: false })).toBe(true);
  });

  it("does not match a bare V — typing v must still reach the host", () => {
    expect(isPasteCombo(key("KeyV"))).toBe(false);
  });

  it("does not match the modifier itself, which is still forwarded", () => {
    expect(isPasteCombo(key("ControlLeft", { ctrlKey: true }))).toBe(false);
  });

  it("does not match another Ctrl chord", () => {
    for (const code of ["KeyC", "KeyX", "KeyA", "KeyZ"]) {
      expect(isPasteCombo(key(code, { ctrlKey: true }))).toBe(false);
    }
  });
});

describe("isCopyCombo — the cue to fetch the host clipboard", () => {
  it("matches copy and cut, on both modifiers", () => {
    expect(isCopyCombo(key("KeyC", { ctrlKey: true }))).toBe(true);
    expect(isCopyCombo(key("KeyX", { ctrlKey: true }))).toBe(true);
    expect(isCopyCombo(key("KeyC", { metaKey: true }))).toBe(true);
  });

  it("ignores an unmodified C or X", () => {
    expect(isCopyCombo(key("KeyC"))).toBe(false);
    expect(isCopyCombo(key("KeyX"))).toBe(false);
  });

  it("ignores paste, so one keystroke never triggers both directions", () => {
    expect(isCopyCombo(key("KeyV", { ctrlKey: true }))).toBe(false);
  });
});

it("waits long enough for the host to have actually copied before reading", () => {
  // The keystroke still has to cross the WS, be injected, and be handled by the focused app.
  // Reading immediately just reads the previous clipboard contents.
  expect(CLIPBOARD_READ_DELAY_MS).toBeGreaterThanOrEqual(250);
});
