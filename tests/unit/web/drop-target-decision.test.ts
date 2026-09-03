import { describe, it, expect } from "bun:test";
import { decideDrop, type DropDecisionInput } from "../../../src/web/components/os-explorer/dnd/drop-target-decision.ts";
import { ENTRY_DRAG_MIME, type EntryDragPayload } from "../../../src/web/components/os-explorer/dnd/entry-drag-payload.ts";

const NO_MODIFIERS = { ctrlKey: false, altKey: false };

function input(overrides: Partial<DropDecisionInput>): DropDecisionInput {
  return {
    types: [ENTRY_DRAG_MIME],
    payload: { paths: ["/src/a.txt"], origin: "explorer" },
    targetDir: "/dst",
    modifiers: NO_MODIFIERS,
    ...overrides,
  };
}

describe("decideDrop", () => {
  it("rejects a drag with no entry-drag MIME (e.g. a tab drag)", () => {
    const decision = decideDrop(input({ types: ["application/ppm-tab"] }));
    expect(decision).toEqual({ accept: false, reason: "not-an-entry-drag" });
  });

  it("rejects a null or empty target directory", () => {
    expect(decideDrop(input({ targetDir: null })).accept).toBe(false);
    expect(decideDrop(input({ targetDir: "" })).accept).toBe(false);
  });

  it("rejects dropping onto the dragged path itself", () => {
    const decision = decideDrop(input({
      payload: { paths: ["/src/a"], origin: "explorer" },
      targetDir: "/src/a",
    }));
    expect(decision).toEqual({ accept: false, reason: "self-or-descendant" });
  });

  it("rejects dropping onto a descendant of a dragged folder", () => {
    const decision = decideDrop(input({
      payload: { paths: ["/src"], origin: "explorer" },
      targetDir: "/src/child",
    }));
    expect(decision).toEqual({ accept: false, reason: "self-or-descendant" });
  });

  it("rejects a same-directory move as a no-op", () => {
    const decision = decideDrop(input({
      payload: { paths: ["/dst/a.txt"], origin: "explorer" },
      targetDir: "/dst",
      modifiers: NO_MODIFIERS,
    }));
    expect(decision).toEqual({ accept: false, reason: "same-directory" });
  });

  it("allows a same-directory copy (duplicate), unlike a move", () => {
    const decision = decideDrop(input({
      payload: { paths: ["/dst/a.txt"], origin: "explorer" },
      targetDir: "/dst",
      modifiers: { ctrlKey: true, altKey: false },
    }));
    expect(decision).toEqual({ accept: true, op: "copy" });
  });

  it("accepts a valid move to a different directory", () => {
    const decision = decideDrop(input({}));
    expect(decision).toEqual({ accept: true, op: "move" });
  });

  it("resolves copy from ctrl or alt at drop time", () => {
    expect(decideDrop(input({ modifiers: { ctrlKey: true, altKey: false } }))).toEqual({ accept: true, op: "copy" });
    expect(decideDrop(input({ modifiers: { ctrlKey: false, altKey: true } }))).toEqual({ accept: true, op: "copy" });
  });

  it("accepts optimistically when the payload is not yet readable (hover from a foreign tab)", () => {
    const decision = decideDrop(input({ payload: null }));
    expect(decision).toEqual({ accept: true, op: "move" });
  });
});
