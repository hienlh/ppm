/**
 * chat-nav-keybinding — store-level assertions for chat transcript navigation.
 *
 * Validates:
 *   - KEY_ACTIONS contains chat-nav-prev / chat-nav-next with Alt+Arrow defaults
 *   - parseCombo handles multi-character key names (ArrowUp / ArrowDown), so the
 *     combo actually matches a real KeyboardEvent
 *   - No other action claims the same combo
 *
 * Does NOT test the React hook or the DOM listener — those need a browser.
 */
import { describe, it, expect } from "bun:test";

import {
  KEY_ACTIONS,
  parseCombo,
  eventMatchesCombo,
} from "../../../src/web/stores/keybindings-store";

/** Minimal stand-in for the fields eventMatchesCombo reads. */
function keyEvent(key: string, mods: Partial<Record<"ctrlKey" | "metaKey" | "altKey" | "shiftKey", boolean>> = {}) {
  return {
    key,
    ctrlKey: mods.ctrlKey ?? false,
    metaKey: mods.metaKey ?? false,
    altKey: mods.altKey ?? false,
    shiftKey: mods.shiftKey ?? false,
  } as KeyboardEvent;
}

describe("chat nav KEY_ACTIONS entries", () => {
  it("chat-nav-prev defaults to Alt+ArrowUp", () => {
    const action = KEY_ACTIONS.find((a) => a.id === "chat-nav-prev");
    expect(action).toBeDefined();
    expect(action?.defaultKey).toBe("Alt+ArrowUp");
    expect(action?.category).toBe("general");
  });

  it("chat-nav-next defaults to Alt+ArrowDown", () => {
    const action = KEY_ACTIONS.find((a) => a.id === "chat-nav-next");
    expect(action).toBeDefined();
    expect(action?.defaultKey).toBe("Alt+ArrowDown");
    expect(action?.category).toBe("general");
  });

  it("no two actions share a default combo", () => {
    const seen = new Map<string, string>();
    for (const action of KEY_ACTIONS) {
      if (!action.defaultKey) continue;
      const clash = seen.get(action.defaultKey);
      expect(clash, `${action.id} clashes with ${clash} on ${action.defaultKey}`).toBeUndefined();
      seen.set(action.defaultKey, action.id);
    }
  });
});

describe("Alt+Arrow combo matching", () => {
  it("Alt+ArrowUp matches an Alt-held ArrowUp keydown", () => {
    const combo = parseCombo("Alt+ArrowUp");
    expect(eventMatchesCombo(keyEvent("ArrowUp", { altKey: true }), combo)).toBe(true);
  });

  it("Alt+ArrowDown matches an Alt-held ArrowDown keydown", () => {
    const combo = parseCombo("Alt+ArrowDown");
    expect(eventMatchesCombo(keyEvent("ArrowDown", { altKey: true }), combo)).toBe(true);
  });

  it("a bare ArrowUp does not match — Alt is required", () => {
    const combo = parseCombo("Alt+ArrowUp");
    expect(eventMatchesCombo(keyEvent("ArrowUp"), combo)).toBe(false);
  });

  it("the two directions do not match each other", () => {
    expect(eventMatchesCombo(keyEvent("ArrowDown", { altKey: true }), parseCombo("Alt+ArrowUp"))).toBe(false);
    expect(eventMatchesCombo(keyEvent("ArrowUp", { altKey: true }), parseCombo("Alt+ArrowDown"))).toBe(false);
  });

  it("extra modifiers do not match — Alt+Shift+ArrowUp is a different combo", () => {
    const combo = parseCombo("Alt+ArrowUp");
    expect(eventMatchesCombo(keyEvent("ArrowUp", { altKey: true, shiftKey: true }), combo)).toBe(false);
  });
});
