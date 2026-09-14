/**
 * dock-toggle-keybinding — Phase 04 store-level assertions.
 *
 * Validates:
 *   - KEY_ACTIONS contains a "toggle-dock" entry with defaultKey "Mod+'"
 *   - The entry is categorized as "general"
 *   - Ctrl+` also reaches the same toggle, on desktop only
 *   - toggleDock() flips dock.visible (happy path + reverse)
 *
 * Does NOT test the React hook or browser KeyboardEvent dispatch — those
 * require a DOM and belong in integration tests.
 */
import { describe, it, expect, beforeEach } from "bun:test";

// ---------------------------------------------------------------------------
// In-memory localStorage stub — panel-store reads/writes localStorage on import
// ---------------------------------------------------------------------------
const memStore: Record<string, string> = {};
const localStorageStub = {
  getItem: (key: string) => memStore[key] ?? null,
  setItem: (key: string, value: string) => { memStore[key] = value; },
  removeItem: (key: string) => { delete memStore[key]; },
  clear: () => { for (const k of Object.keys(memStore)) delete memStore[k]; },
};
(globalThis as unknown as { localStorage: typeof localStorageStub }).localStorage = localStorageStub;

// Imports after localStorage stub
import { KEY_ACTIONS, matchesDockBacktick, useKeybindingsStore } from "../../../src/web/stores/keybindings-store";
import { usePanelStore } from "../../../src/web/stores/panel-store";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function resetDockState() {
  localStorageStub.clear();
  usePanelStore.setState({
    dock: { visible: false, height: 30 },
    projectDock: {},
    currentProject: "test-project",
  });
}

// ---------------------------------------------------------------------------
// KEY_ACTIONS catalog assertions
// ---------------------------------------------------------------------------
describe("toggle-dock KEY_ACTIONS entry", () => {
  it("toggle-dock action exists in KEY_ACTIONS", () => {
    const action = KEY_ACTIONS.find((a) => a.id === "toggle-dock");
    expect(action).toBeDefined();
  });

  it("toggle-dock defaultKey is Mod+' (opens the terminal panel)", () => {
    const action = KEY_ACTIONS.find((a) => a.id === "toggle-dock");
    expect(action?.defaultKey).toBe("Mod+'");
  });

  it("toggle-dock category is general", () => {
    const action = KEY_ACTIONS.find((a) => a.id === "toggle-dock");
    expect(action?.category).toBe("general");
  });

  it("open-terminal no longer binds Mod+' (repurposed to toggle the panel)", () => {
    const openTerminal = KEY_ACTIONS.find((a) => a.id === "open-terminal");
    const toggleDock = KEY_ACTIONS.find((a) => a.id === "toggle-dock");
    // open-terminal has no default shortcut now; toggle-dock owns Mod+'.
    expect(openTerminal?.defaultKey).toBe("");
    expect(toggleDock?.defaultKey).toBe("Mod+'");
  });
});

// ---------------------------------------------------------------------------
// toggleDock() store behavior
// ---------------------------------------------------------------------------
describe("toggleDock store action", () => {
  beforeEach(resetDockState);

  it("toggleDock() flips dock.visible from false to true", () => {
    usePanelStore.getState().toggleDock();
    expect(usePanelStore.getState().dock.visible).toBe(true);
  });

  it("toggleDock() flips dock.visible from true to false", () => {
    usePanelStore.setState({ dock: { visible: true, height: 30 } });
    usePanelStore.getState().toggleDock();
    expect(usePanelStore.getState().dock.visible).toBe(false);
  });

  it("toggleDock() preserves dock.height", () => {
    usePanelStore.setState({ dock: { visible: false, height: 40 } });
    usePanelStore.getState().toggleDock();
    expect(usePanelStore.getState().dock.height).toBe(40);
  });
});

// ---------------------------------------------------------------------------
// Ctrl+` — VS Code's terminal toggle, desktop only
// ---------------------------------------------------------------------------

/** Minimal stand-in for the fields the combo matchers read. */
function keyEvent(key: string, mods: Partial<Record<"ctrlKey" | "metaKey" | "altKey" | "shiftKey", boolean>> = {}) {
  return {
    key,
    ctrlKey: mods.ctrlKey ?? false,
    metaKey: mods.metaKey ?? false,
    altKey: mods.altKey ?? false,
    shiftKey: mods.shiftKey ?? false,
  } as KeyboardEvent;
}

describe("matchesDockBacktick", () => {
  it("matches Ctrl+` on desktop", () => {
    expect(matchesDockBacktick(keyEvent("`", { ctrlKey: true }), false)).toBe(true);
  });

  it("does not match on mobile — the dock is the mobile nav's bottom sheet there", () => {
    expect(matchesDockBacktick(keyEvent("`", { ctrlKey: true }), true)).toBe(false);
  });

  it("a bare backtick does not match — Ctrl is required", () => {
    expect(matchesDockBacktick(keyEvent("`"), false)).toBe(false);
  });

  it("extra modifiers do not match", () => {
    expect(matchesDockBacktick(keyEvent("`", { ctrlKey: true, shiftKey: true }), false)).toBe(false);
    expect(matchesDockBacktick(keyEvent("`", { ctrlKey: true, altKey: true }), false)).toBe(false);
    expect(matchesDockBacktick(keyEvent("`", { metaKey: true }), false)).toBe(false);
  });

  it("no customizable action claims Ctrl+`, so nothing shadows it", () => {
    const { matchesEvent } = useKeybindingsStore.getState();
    const e = keyEvent("`", { ctrlKey: true });
    for (const action of KEY_ACTIONS) {
      expect(matchesEvent(e, action.id), `${action.id} claims Ctrl+\``).toBe(false);
    }
  });
});
