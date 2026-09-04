// Run in Docker if the host segfaults: docker run --rm -v "$PWD":/app -w /app oven/bun bun test tests/unit/web/resolve-open-system-monitor-action.test.ts
import { describe, it, expect } from "bun:test";
import { resolveOpenSystemMonitorAction } from "../../../src/web/components/system/resolve-open-system-monitor-action.ts";

describe("resolveOpenSystemMonitorAction — viewport routing", () => {
  it("mobile (< md): opens the existing system-monitor tab, never a no-op", () => {
    const action = resolveOpenSystemMonitorAction(true, null);
    expect(action.kind).toBe("tab");
    if (action.kind === "tab") {
      expect(action.tab).toEqual({
        type: "system-monitor",
        title: "System Monitor",
        projectId: null,
        closable: true,
      });
    }
  });

  it("mobile: an already-open desktop window id is ignored — mobile always gets the tab", () => {
    const action = resolveOpenSystemMonitorAction(true, "win-123");
    expect(action.kind).toBe("tab");
  });

  it("desktop, no existing window: opens the floating window", () => {
    const action = resolveOpenSystemMonitorAction(false, null);
    expect(action).toEqual({ kind: "window" });
  });

  it("desktop, a system-monitor window is already open: focuses it instead of opening a duplicate", () => {
    const action = resolveOpenSystemMonitorAction(false, "win-abc123");
    expect(action).toEqual({ kind: "focus", id: "win-abc123" });
  });
});
