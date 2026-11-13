/**
 * A tab in the saved layout whose panel is missing dispatches the panel's command to get it
 * back, on every reload and every device. That tab can have come from a link, so it may only run
 * a command its owning extension recorded on it, or one the extension marked linkable.
 */
import { describe, it, expect } from "bun:test";
import { mayRecoverPanel, panelCommandOf } from "../../../src/web/lib/extension-panel-recovery";
import type { ExtensionContributes } from "../../../src/types/extension";

const contributions = {
  commands: [
    { command: "midday.checkIn", title: "Check-in", extId: "ppm-midday" },
    { command: "midday.done", title: "Done", extId: "ppm-midday" },
    { command: "git-graph.view", title: "Git Graph", extId: "ext-git-graph" },
  ],
  deepLinkCommands: ["midday.checkIn"],
} as unknown as ExtensionContributes;

describe("panelCommandOf", () => {
  it("gives a .view slug its suffix back and keeps a dotted id", () => {
    expect(panelCommandOf("git-graph")).toBe("git-graph.view");
    expect(panelCommandOf("midday.checkIn")).toBe("midday.checkIn");
  });
});

describe("mayRecoverPanel", () => {
  it("reopens a panel its own extension recorded on the tab", () => {
    expect(mayRecoverPanel({ viewType: "git-graph", extensionId: "ext-git-graph" }, contributions)).toBe(true);
  });

  it("reopens a linkable panel from a tab that records no owner (a deep link's tab)", () => {
    expect(mayRecoverPanel({ viewType: "midday.checkIn" }, contributions)).toBe(true);
  });

  it("never re-runs an unlisted command from a tab that records no owner", () => {
    // A tab persisted from `/?extView=midday.done`: on reload it must not run midday.done again.
    expect(mayRecoverPanel({ viewType: "midday.done" }, contributions)).toBe(false);
  });

  it("refuses a tab whose recorded owner does not own the command", () => {
    expect(mayRecoverPanel({ viewType: "midday.done", extensionId: "ext-git-graph" }, contributions)).toBe(false);
  });

  it("waits for contributions, and needs a view type", () => {
    expect(mayRecoverPanel({ viewType: "midday.checkIn" }, null)).toBe(false);
    expect(mayRecoverPanel({ extensionId: "ppm-midday" }, contributions)).toBe(false);
  });
});
