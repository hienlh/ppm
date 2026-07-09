/**
 * Pure dock-layout resolver tests (position-configurable dock, Phase 2).
 * DOM-free: validates orientation, render order, size string, and border edge
 * that panel-layout.tsx derives from dock position + size ratio + maximize flag.
 */
import { describe, it, expect } from "bun:test";
import {
  resolveDockLayout,
  DOCK_EXPANDED_BOTTOM,
  DOCK_EXPANDED_SIDE,
} from "../../../src/web/components/layout/dock-layout";

describe("resolveDockLayout — bottom", () => {
  it("uses vertical orientation, dock after grid", () => {
    const c = resolveDockLayout("bottom", 30, false);
    expect(c.orientation).toBe("vertical");
    expect(c.dockFirst).toBe(false);
  });

  it("dockSize = sizeRatio% when not expanded", () => {
    expect(resolveDockLayout("bottom", 30, false).dockSize).toBe("30%");
  });

  it("dockSize = 70% when expanded", () => {
    expect(resolveDockLayout("bottom", 30, true).dockSize).toBe(`${DOCK_EXPANDED_BOTTOM}%`);
  });

  it("border edge = top", () => {
    expect(resolveDockLayout("bottom", 30, false).borderEdge).toBe("top");
  });
});

describe("resolveDockLayout — right", () => {
  it("uses horizontal orientation, dock after grid", () => {
    const c = resolveDockLayout("right", 30, false);
    expect(c.orientation).toBe("horizontal");
    expect(c.dockFirst).toBe(false);
  });

  it("dockSize = 55% when expanded", () => {
    expect(resolveDockLayout("right", 30, true).dockSize).toBe(`${DOCK_EXPANDED_SIDE}%`);
  });

  it("border edge = left (faces grid on its left)", () => {
    expect(resolveDockLayout("right", 30, false).borderEdge).toBe("left");
  });
});

describe("resolveDockLayout — left", () => {
  it("uses horizontal orientation, dock BEFORE grid", () => {
    const c = resolveDockLayout("left", 30, false);
    expect(c.orientation).toBe("horizontal");
    expect(c.dockFirst).toBe(true);
  });

  it("dockSize = sizeRatio% when not expanded", () => {
    expect(resolveDockLayout("left", 25, false).dockSize).toBe("25%");
  });

  it("border edge = right (faces grid on its right)", () => {
    expect(resolveDockLayout("left", 30, false).borderEdge).toBe("right");
  });
});

describe("resolveDockLayout — size is always a % string (no px-as-number bug)", () => {
  it("all positions return a string ending in %", () => {
    for (const pos of ["left", "bottom", "right"] as const) {
      expect(resolveDockLayout(pos, 42, false).dockSize.endsWith("%")).toBe(true);
      expect(resolveDockLayout(pos, 42, true).dockSize.endsWith("%")).toBe(true);
    }
  });
});
