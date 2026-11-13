/**
 * A policy-bound chat (an extension's chat with a tool policy) is clamped server-side to
 * "default" or "acceptEdits" — see `clampBoundPermissionMode` in
 * `src/providers/extension-tool-policy.ts`. Before this fix the composer still showed whatever
 * `permissionMode` was locally selected, so a chat the server ran as `acceptEdits` could show
 * "Bypass permissions", and the picker offered bypass/plan even though the server would clamp
 * either one right back to `acceptEdits`.
 */
import { describe, expect, it, afterEach } from "bun:test";
import { installDom, uninstallDom, mount } from "../../helpers/react-dom";
import { composerModeFor, BOUND_ALLOWED_MODE_IDS, ModeSelector } from "../../../src/web/components/chat/mode-selector";

installDom();
afterEach(uninstallDom);

describe("composerModeFor", () => {
  it("shows the locally-selected mode, and restricts nothing, for an ordinary (unbound) chat", () => {
    expect(composerModeFor("acceptEdits", null)).toEqual({ mode: "acceptEdits", allowedModeIds: undefined });
    expect(composerModeFor(undefined, null)).toEqual({ mode: undefined, allowedModeIds: undefined });
    expect(composerModeFor(undefined, undefined)).toEqual({ mode: undefined, allowedModeIds: undefined });
  });

  it("the server's clamped mode wins over a locally-selected bypass, for a bound chat", () => {
    expect(composerModeFor("bypassPermissions", "acceptEdits")).toEqual({
      mode: "acceptEdits", allowedModeIds: BOUND_ALLOWED_MODE_IDS,
    });
    expect(composerModeFor("plan", "default")).toEqual({
      mode: "default", allowedModeIds: BOUND_ALLOWED_MODE_IDS,
    });
  });
});

function optionLabels(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[role="option"]')].map((el) => el.textContent ?? "");
}

describe("ModeSelector, allowedModeIds", () => {
  it("offers every mode when unrestricted (ordinary chat, unchanged behaviour)", async () => {
    const view = await mount(
      <ModeSelector value="bypassPermissions" onChange={() => {}} open onOpenChange={() => {}} />,
    );
    try {
      const labels = optionLabels(view.container).join(" | ");
      expect(labels).toContain("Ask before edits");
      expect(labels).toContain("Edit automatically");
      expect(labels).toContain("Plan mode");
      expect(labels).toContain("Bypass permissions");
    } finally {
      await view.unmount();
    }
  });

  it("offers only the two modes a bound chat may run in — never plan or bypass", async () => {
    const view = await mount(
      <ModeSelector
        value="acceptEdits"
        onChange={() => {}}
        open
        onOpenChange={() => {}}
        allowedModeIds={BOUND_ALLOWED_MODE_IDS}
      />,
    );
    try {
      const options = [...view.container.querySelectorAll('[role="option"]')];
      expect(options).toHaveLength(2);
      const labels = options.map((el) => el.textContent ?? "").join(" | ");
      expect(labels).toContain("Ask before edits");
      expect(labels).toContain("Edit automatically");
      expect(labels).not.toContain("Plan mode");
      expect(labels).not.toContain("Bypass permissions");
    } finally {
      await view.unmount();
    }
  });
});
