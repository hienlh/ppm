// Run in Docker if the host segfaults: docker run --rm -v "$PWD":/app -w /app oven/bun bun test tests/unit/web/resolve-open-settings-action.test.ts
import { describe, it, expect } from "bun:test";
import { resolveOpenSettingsAction } from "../../../src/web/components/settings/resolve-open-settings-action.ts";

describe("resolveOpenSettingsAction — viewport routing", () => {
  it("mobile (< md): opens the settings tab, never a window that would not render", () => {
    const action = resolveOpenSettingsAction(true, null);
    expect(action.kind).toBe("tab");
    if (action.kind === "tab") {
      expect(action.tab).toEqual({
        type: "settings",
        title: "Settings",
        projectId: null,
        closable: true,
      });
    }
  });

  it("mobile: an already-open desktop window id is ignored — mobile always gets the tab", () => {
    const action = resolveOpenSettingsAction(true, "win-123");
    expect(action.kind).toBe("tab");
  });

  it("desktop, no existing window: opens the floating window", () => {
    const action = resolveOpenSettingsAction(false, null);
    expect(action).toEqual({ kind: "window" });
  });

  it("desktop, a settings window is already open: focuses it instead of opening a duplicate", () => {
    const action = resolveOpenSettingsAction(false, "win-abc123");
    expect(action).toEqual({ kind: "focus", id: "win-abc123" });
  });
});

describe("resolveOpenSettingsAction — deep link to a category", () => {
  it("carries the category when opening a new window", () => {
    expect(resolveOpenSettingsAction(false, null, "accounts")).toEqual({
      kind: "window",
      category: "accounts",
    });
  });

  it("carries the category when focusing an open window, so the pane actually moves", () => {
    expect(resolveOpenSettingsAction(false, "win-9", "accounts")).toEqual({
      kind: "focus",
      id: "win-9",
      category: "accounts",
    });
  });

  it("mobile carries the category as tab metadata, using the field tabs already persist", () => {
    const action = resolveOpenSettingsAction(true, null, "accounts");
    expect(action.kind).toBe("tab");
    if (action.kind === "tab") {
      expect(action.tab.metadata).toEqual({ category: "accounts" });
    }
  });

  it("omits the key entirely when no category is asked for, so payloads stay clean", () => {
    const action = resolveOpenSettingsAction(true, null);
    expect(action.kind).toBe("tab");
    if (action.kind === "tab") expect("metadata" in action.tab).toBe(false);
    expect("category" in resolveOpenSettingsAction(false, null)).toBe(false);
  });
});
