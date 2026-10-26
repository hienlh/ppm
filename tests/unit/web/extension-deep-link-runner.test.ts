import { describe, it, expect } from "bun:test";
import { runExtensionDeepLink, DEEP_LINK_WAIT_MS, type DeepLinkRunnerDeps } from "../../../src/web/lib/extension-deep-link-runner";

/** Stand-ins for the stores and the window: contributions can be published and time advanced. */
function harness(initial: string[] | null) {
  let commands = initial;
  const listeners = new Set<() => void>();
  const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
  const dispatched: Array<{ command: string; args: unknown[] }> = [];
  const opened: Array<{ view: string; title: string; projectName?: string }> = [];
  const warnings: string[] = [];
  const deps: DeepLinkRunnerDeps = {
    commands: () => commands,
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
    publish(next: string[]) { commands = next; for (const l of [...listeners]) l(); },
    fireTimers() { for (const t of timers) if (!t.cancelled) t.fn(); },
    timers,
  };
}

describe("runExtensionDeepLink", () => {
  it("dispatches a listed command at once, with its args", async () => {
    const h = harness(["midday.checkIn"]);
    expect(await runExtensionDeepLink({ kind: "command", command: "midday.checkIn", args: ["today"] }, h.deps)).toBe(true);
    expect(h.dispatched).toEqual([{ command: "midday.checkIn", args: ["today"] }]);
  });

  it("waits for contributions to list the command on a cold boot, then dispatches once", async () => {
    const h = harness(null);
    const done = runExtensionDeepLink({ kind: "command", command: "midday.checkIn", args: [] }, h.deps);
    expect(h.dispatched).toHaveLength(0);
    h.publish(["git.graph"]);
    expect(h.dispatched).toHaveLength(0);
    h.publish(["git.graph", "midday.checkIn"]);
    h.publish(["git.graph", "midday.checkIn"]);
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
    h.publish(["nope.cmd"]);
    expect(h.dispatched).toHaveLength(0);
  });

  it("opens a view as a tab named after the command's title, scoped to the link's project", async () => {
    const h = harness(["midday.checkIn"]);
    await runExtensionDeepLink({ kind: "view", view: "midday.checkIn", projectName: "ppm" }, h.deps);
    expect(h.opened).toEqual([{ view: "midday.checkIn", title: "Midday: Check-in", projectName: "ppm" }]);
    expect(h.dispatched).toHaveLength(0);
  });
});
