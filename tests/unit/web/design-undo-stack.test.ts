import { describe, expect, it } from "bun:test";
import {
  MAX_UNDO_DEPTH, designUndoDepth, dropDesignUndo, peekDesignUndo, pushDesignUndo, subscribeDesignUndo,
} from "../../../src/web/components/design/transform/design-undo-stack";

describe("design undo stack", () => {
  it("is per tab, newest on top", () => {
    pushDesignUndo("tab-a", "a1");
    pushDesignUndo("tab-a", "a2");
    pushDesignUndo("tab-b", "b1");
    expect(peekDesignUndo("tab-a")).toBe("a2");
    expect(peekDesignUndo("tab-b")).toBe("b1");
    expect(peekDesignUndo("tab-none")).toBeNull();
    expect(designUndoDepth("tab-a")).toBe(2);
  });

  it("drops one entry and leaves the ones below it usable", () => {
    for (const id of ["c1", "c2", "c3"]) pushDesignUndo("tab-c", id);
    dropDesignUndo("tab-c", "c3");
    expect(peekDesignUndo("tab-c")).toBe("c2");
    dropDesignUndo("tab-c", "c1");
    expect(peekDesignUndo("tab-c")).toBe("c2");
    expect(designUndoDepth("tab-c")).toBe(1);
    dropDesignUndo("tab-c", "unknown");
    expect(designUndoDepth("tab-c")).toBe(1);
  });

  it("keeps at most the newest 50", () => {
    for (let i = 0; i < MAX_UNDO_DEPTH + 5; i++) pushDesignUndo("tab-d", `d${i}`);
    expect(designUndoDepth("tab-d")).toBe(MAX_UNDO_DEPTH);
    expect(peekDesignUndo("tab-d")).toBe(`d${MAX_UNDO_DEPTH + 4}`);
  });

  it("tells subscribers about every change", () => {
    let calls = 0;
    const off = subscribeDesignUndo(() => { calls++; });
    pushDesignUndo("tab-e", "e1");
    dropDesignUndo("tab-e", "e1");
    off();
    pushDesignUndo("tab-e", "e2");
    expect(calls).toBe(2);
  });
});
