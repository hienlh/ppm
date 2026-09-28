/**
 * An extension names its icons in its manifest, and something has to draw them.
 *
 * The names are inert strings until a table maps them, and the failure is
 * silent in the worst way: every panel the extension opens gets the generic
 * puzzle piece, so the graph, a blame, a file history and an interactive rebase
 * are four tabs wearing the same glyph. This suite pairs the two — every icon a
 * *bundled* extension asks for must resolve, and the tab must end up with the
 * icon of the command that opened it.
 */
import { describe, it, expect } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { EXTENSION_ICONS, extensionIcon, viewTypeIcon } from "../../../src/web/lib/extension-icons.ts";
import { getTabIcon } from "../../../src/web/lib/tab-type-icons.ts";
import { useExtensionStore } from "../../../src/web/stores/extension-store.ts";
import { GitBranch, History, Puzzle, Users } from "../../../src/web/lib/icons.ts";
import type { ExtensionContributes } from "../../../src/types/extension.ts";

const PACKAGES = resolve(import.meta.dir, "../../../packages");

/** Every manifest PPM ships in-tree. */
function bundledManifests(): { id: string; manifest: Record<string, any> }[] {
  return readdirSync(PACKAGES)
    .filter((name) => name.startsWith("ext-"))
    .map((name) => ({
      id: name,
      manifest: JSON.parse(readFileSync(join(PACKAGES, name, "package.json"), "utf-8")),
    }));
}

describe("extension icons: the names a manifest may use", () => {
  it("draws every icon a bundled extension asks for", () => {
    const missing: string[] = [];
    for (const { id, manifest } of bundledManifests()) {
      const names = [
        manifest.ppm?.icon,
        ...(manifest.contributes?.commands ?? []).map((c: { icon?: string }) => c.icon),
      ].filter(Boolean) as string[];
      expect(names.length).toBeGreaterThan(0);
      for (const name of names) {
        if (!extensionIcon(name)) missing.push(`${id}: ${name}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("answers for an unknown name rather than throwing", () => {
    // A third-party extension may name anything; the caller's fallback decides.
    expect(extensionIcon("no-such-icon")).toBeUndefined();
    expect(extensionIcon(undefined)).toBeUndefined();
    expect(extensionIcon("")).toBeUndefined();
  });

  it("names its entries the way a manifest writes them", () => {
    for (const name of Object.keys(EXTENSION_ICONS)) {
      expect(name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    }
  });
});

const CONTRIBUTIONS: ExtensionContributes = {
  commands: [
    { command: "git-graph.view", title: "Git Graph: View Repository", icon: "git-branch" },
    { command: "git-graph.blame", title: "Git Graph: Blame File", icon: "users" },
    { command: "git-graph.reflog", title: "Git Graph: Reflog", icon: "history" },
    { command: "other.thing", title: "No icon at all" },
  ],
};

describe("extension icons: which glyph a panel's tab gets", () => {
  it("matches a viewType whose trailing .view the tab has already stripped", () => {
    // The panel's viewType is its command id, and the tab carries the slug.
    expect(viewTypeIcon(CONTRIBUTIONS, "git-graph")).toBe(GitBranch);
    expect(viewTypeIcon(CONTRIBUTIONS, "git-graph.view")).toBe(GitBranch);
    expect(viewTypeIcon(CONTRIBUTIONS, "git-graph.blame")).toBe(Users);
    expect(viewTypeIcon(CONTRIBUTIONS, "git-graph.reflog")).toBe(History);
  });

  it("gives nothing for a command with no icon, or no contributions at all", () => {
    expect(viewTypeIcon(CONTRIBUTIONS, "other.thing")).toBeUndefined();
    expect(viewTypeIcon(CONTRIBUTIONS, "never.registered")).toBeUndefined();
    expect(viewTypeIcon(null, "git-graph")).toBeUndefined();
    expect(viewTypeIcon(CONTRIBUTIONS, undefined)).toBeUndefined();
  });

  it("labels an extension's tab with it, and falls back to the puzzle piece", () => {
    useExtensionStore.getState().setContributions(CONTRIBUTIONS);
    const tab = (viewType?: string) => ({
      type: "extension" as const,
      title: "Git Graph: ppm",
      metadata: viewType ? { viewType } : undefined,
    });
    expect(getTabIcon(tab("git-graph"))).toBe(GitBranch);
    expect(getTabIcon(tab("git-graph.blame"))).toBe(Users);
    // A panel whose extension said nothing about it is still a panel.
    expect(getTabIcon(tab("other.thing"))).toBe(Puzzle);
    expect(getTabIcon(tab())).toBe(Puzzle);
  });
});
