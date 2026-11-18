/**
 * A window's tile colour must name a variable that exists at runtime. The tones were
 * `var(--color-<token>)`, but `globals.css` declares those under `@theme inline`, where Tailwind
 * writes each utility with the underlying `var(--accent-2)` and emits a `--color-*` variable
 * only when something it scans spells it out. `--color-accent-2`, `--color-info`,
 * `--color-text-2` and `--color-text-3` were never emitted, so the chat, Assistant, agent,
 * Explorer, Remote Desktop, Logs and Settings tiles had no colour at all (a transparent tile
 * and icon) while the editor's `--color-primary`, emitted for other reasons, did.
 * The runtime tokens themselves are declared in the stylesheet's `:root` and set by `applyTheme`.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { installDom, uninstallDom } from "../../helpers/react-dom.tsx";

installDom();
afterAll(uninstallDom);

const { describeWindow, designTone } = await import("../../../src/web/components/floating-window/use-window-meta");
type Tab = import("../../../src/web/stores/tab-store").Tab;

const globals = readFileSync(resolve(import.meta.dir, "../../../src/web/styles/globals.css"), "utf8");
const rootBlock = /:root\s*\{([\s\S]*?)\n\}/.exec(globals)?.[1] ?? "";
const runtimeVars = new Set([...rootBlock.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));

const KINDS = ["explorer", "agent-session", "system-monitor", "remote-desktop", "settings", "logs", "release-notes"] as const;
const TAB_TYPES = ["chat", "assistant", "terminal", "editor", "git-log", "git-diff", "git-review", "database"] as const;

function tones(): string[] {
  const out = KINDS.map((k) => describeWindow(k, undefined, false).tone);
  for (const type of TAB_TYPES) {
    out.push(describeWindow("tab-host", { id: type, type, title: type, projectId: "p" } as Tab, false).tone);
  }
  for (const slug of ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"]) out.push(designTone(slug));
  return [...new Set(out)];
}

describe("window tile tones", () => {
  it("reads the runtime theme tokens", () => {
    expect(runtimeVars.has("--accent-2")).toBe(true);
    const unresolved = tones().filter((t) => {
      const name = /^var\((--[a-z0-9-]+)\)$/.exec(t)?.[1];
      return !name || !runtimeVars.has(name);
    });
    expect(unresolved).toEqual([]);
  });
});
