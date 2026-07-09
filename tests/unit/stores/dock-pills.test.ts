/**
 * Pure dock-pill visibility resolver tests (Phase 3).
 * Bottom shows all pills; vertical positions collapse to 2 pills + overflow,
 * always keeping the active tab visible.
 */
import { describe, it, expect } from "bun:test";
import { resolveDockPills, DOCK_PILL_CAP } from "../../../src/web/components/layout/dock-pills";

describe("resolveDockPills — bottom", () => {
  it("shows all pills, no overflow, labels on (iconOnlyInactive=false)", () => {
    const r = resolveDockPills(["a", "b", "c", "d"], "b", "bottom");
    expect(r.visible).toEqual(["a", "b", "c", "d"]);
    expect(r.overflow).toEqual([]);
    expect(r.iconOnlyInactive).toBe(false);
  });
});

describe("resolveDockPills — vertical, few tabs", () => {
  it("left with ≤2 tabs shows all, icon-only inactive, no overflow", () => {
    const r = resolveDockPills(["a", "b"], "a", "left");
    expect(r.visible).toEqual(["a", "b"]);
    expect(r.overflow).toEqual([]);
    expect(r.iconOnlyInactive).toBe(true);
  });
});

describe("resolveDockPills — vertical, overflow", () => {
  it("right with 5 tabs, active is first → visible [a,b], overflow rest", () => {
    const r = resolveDockPills(["a", "b", "c", "d", "e"], "a", "right");
    expect(r.visible).toEqual(["a", "b"]);
    expect(r.overflow).toEqual(["c", "d", "e"]);
    expect(r.visible.length).toBe(DOCK_PILL_CAP);
  });

  it("right with 5 tabs, active in the middle → active kept visible", () => {
    const r = resolveDockPills(["a", "b", "c", "d", "e"], "d", "right");
    expect(r.visible).toContain("d");
    expect(r.visible.length).toBe(DOCK_PILL_CAP);
    expect(r.overflow).not.toContain("d");
    // original order preserved
    expect(r.visible).toEqual(["a", "d"]);
    expect(r.overflow).toEqual(["b", "c", "e"]);
  });

  it("left with 5 tabs, active is last → active kept visible", () => {
    const r = resolveDockPills(["a", "b", "c", "d", "e"], "e", "left");
    expect(r.visible).toEqual(["a", "e"]);
    expect(r.overflow).toEqual(["b", "c", "d"]);
  });

  it("no active id → falls back to first N tabs", () => {
    const r = resolveDockPills(["a", "b", "c"], null, "right");
    expect(r.visible).toEqual(["a", "b"]);
    expect(r.overflow).toEqual(["c"]);
  });
});
