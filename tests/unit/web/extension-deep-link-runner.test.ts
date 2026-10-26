import { describe, it, expect } from "bun:test";
import { runExtensionDeepLink, DEEP_LINK_WAIT_MS, type DeepLinkRunnerDeps } from "../../../src/web/lib/extension-deep-link-runner";

/**
 * Stand-ins for the stores and the window: contributions (declared commands, and the ones an
 * extension lets a link run) can be published and time advanced.
 */
function harness(initial: string[] | null, initialLinkable: string[] = []) {
  let commands = initial;
  let linkable = initialLinkable;
  const listeners = new Set<() => void>();
  const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
  const dispatched: Array<{ command: string; args: unknown[] }> = [];
  const opened: Array<{ view: string; title: string; projectName?: string }> = [];
  const warnings: string[] = [];
  const deps: DeepLinkRunnerDeps = {
    commands: () => commands,
    deepLinkCommands: () => linkable,
    subscribe: (l) => { listeners.add(l); return () => listeners.delete(l); },
    dispatchCommand: (command, args) => dispatched.push({ command, args }),
    openViewTab: (view, title, projectName) => opened.push({ view, title, ...(projectName && { projectName }) }),
    titleOf: (c) => (c === "midday.checkIn" ? "Midday: Check-in" : undefined),
    warn: (m) => warnings.push(m),
    setTimer: (fn, ms) => {
      const t = { fn, ms, cancelled: false };
      timers.push(t);
      return () => { t.cancelled = true; };
    },
  };
  return {
    deps, dispatched, opened, warnings, listeners,
    publish(next: string[], nextLinkable: string[] = linkable) {
      commands = next;
      linkable = nextLinkable;
      for (const l of [...listeners]) l();
    },
    fireTimers() { for (const t of timers) if (!t.cancelled) t.fn(); },
    timers,
  };
}

describe("runExtensionDeepLink", () => {
  it("dispatches a linkable command at once, with its args", async () => {
    const h = harness(["midday.checkIn"], ["midday.checkIn"]);
    expect(await runExtensionDeepLink({ kind: "command", command: "midday.checkIn", args: ["today"] }, h.deps)).toBe(true);
    expect(h.dispatched).toEqual([{ command: "midday.checkIn", args: ["today"] }]);
  });

  it("refuses a declared command its extension did not list as linkable, even from a hand-made URL", async () => {
    // `/?extCommand=midday.done&extArgs=…` typed or sent by anyone: the server never built it.
    const h = harness(["midday.checkIn", "midday.done"], ["midday.checkIn"]);
    expect(await runExtensionDeepLink({ kind: "command", command: "midday.done", args: ["item-1"] }, h.deps)).toBe(false);
    expect(h.dispatched).toEqual([]);
    expect(h.warnings[0]).toContain("deepLinkCommands");
    expect(h.timers).toHaveLength(0); // refused at once, not left waiting
  });

  it("refuses it too when it only shows up after a cold boot", async () => {
    const h = harness(null);
    const done = runExtensionDeepLink({ kind: "command", command: "midday.done", args: [] }, h.deps);
    h.publish(["midday.checkIn", "midday.done"], ["midday.checkIn"]);
    expect(await done).toBe(false);
    expect(h.dispatched).toEqual([]);
    expect(h.listeners.size).toBe(0);
  });

  it("waits for contributions to list a linkable command on a cold boot, then dispatches once", async () => {
    const h = harness(null);
    const done = runExtensionDeepLink({ kind: "command", command: "midday.checkIn", args: [] }, h.deps);
    expect(h.dispatched).toHaveLength(0);
    h.publish(["git.graph"]);
    expect(h.dispatched).toHaveLength(0);
    h.publish(["git.graph", "midday.checkIn"], ["midday.checkIn"]);
    h.publish(["git.graph", "midday.checkIn"], ["midday.checkIn"]);
    expect(await done).toBe(true);
    expect(h.dispatched).toEqual([{ command: "midday.checkIn", args: [] }]);
    expect(h.listeners.size).toBe(0);
    expect(h.timers[0]!.cancelled).toBe(true);
  });

  it("drops a command that never shows up within the wait, with a warning", async () => {
    const h = harness([]);
    const done = runExtensionDeepLink({ kind: "command", command: "nope.cmd", args: [] }, h.deps);
    expect(h.timers[0]!.ms).toBe(DEEP_LINK_WAIT_MS);
    h.fireTimers();
    expect(await done).toBe(false);
    expect(h.dispatched).toHaveLength(0);
    expect(h.warnings[0]).toContain("nope.cmd");
    h.publish(["nope.cmd"], ["nope.cmd"]);
    expect(h.dispatched).toHaveLength(0);
  });

  it("opens a view by id without any deepLinkCommands entry, as a tab named after the command's title", async () => {
    const h = harness(["midday.checkIn"], []);
    await runExtensionDeepLink({ kind: "view", view: "midday.checkIn", projectName: "ppm" }, h.deps);
    expect(h.opened).toEqual([{ view: "midday.checkIn", title: "Midday: Check-in", projectName: "ppm" }]);
    expect(h.dispatched).toHaveLength(0);
  });
});
