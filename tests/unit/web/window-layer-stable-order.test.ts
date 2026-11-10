/**
 * The window layer keeps its windows in a stable DOM order. Stacking is `zIndex` from `rank`;
 * rendering them in rank order moved the raised window's node on every focus, and a titlebar
 * button pressed on a background window (its press raises it) then lost its click: the browser
 * drops a click whose target left the document mid-press. Pinned at the source, because the
 * layer itself mounts the whole window manager.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { windowsInOpenOrder } from "../../../src/web/components/floating-window/window-store";
import type { WindowRuntimeState } from "../../../src/web/components/floating-window/window-store-types";

const layer = readFileSync(resolve(import.meta.dir, "../../../src/web/components/floating-window/window-layer.tsx"), "utf8");

const win = (id: string, rank: number, opened: number): WindowRuntimeState => ({
  id, kind: "logs", rect: { x: 0, y: 0, w: 100, h: 100 }, rank, opened, state: "normal",
});

describe("window layer DOM order", () => {
  it("renders windows in the order they were opened, not in stacking order", () => {
    expect(layer).toContain("windowsInOpenOrder(windows)");
    expect(layer).not.toContain("windowsInRankOrder(");
  });

  it("open order does not change when a window is raised", () => {
    const before = windowsInOpenOrder({ a: win("a", 0, 1), b: win("b", 1, 2) }).map((w) => w.id);
    const raised = windowsInOpenOrder({ a: win("a", 1, 1), b: win("b", 0, 2) }).map((w) => w.id);
    expect(before).toEqual(["a", "b"]);
    expect(raised).toEqual(before);
  });
});
