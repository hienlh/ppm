/**
 * The skip list is the only thing standing between a PiP keystroke and a global
 * shortcut: `forwardKeyEvents` re-dispatches on the main `window`, so `event.target`
 * there is the window and the app's own text-input guard never trips.
 *
 * Nodes created in the PiP realm fail `instanceof Element`, so the predicate is
 * duck-typed on `closest` — the fakes below are exactly that shape.
 */
import { describe, it, expect } from "bun:test";
import {
  isEditableTarget,
  SKIP_SELECTOR,
} from "../../../src/web/components/floating-window/pip/pip-key-forward.ts";

/** A target that answers `closest` for the selectors it "matches", recording the query. */
function fakeTarget(matches: string[], queries: string[] = []): EventTarget {
  return {
    queries,
    closest(selector: string) {
      queries.push(selector);
      const wanted = selector.split(", ");
      return wanted.some((s) => matches.includes(s)) ? { tag: matches[0] } : null;
    },
  } as unknown as EventTarget;
}

describe("SKIP_SELECTOR", () => {
  it("covers the surfaces that own their keyboard input", () => {
    const parts = SKIP_SELECTOR.split(", ");
    // Monaco's EditContext host is a div and xterm listens on a helper textarea, so
    // neither is caught by the plain input/textarea entries.
    expect(parts).toEqual([
      "input",
      "textarea",
      "select",
      "[contenteditable]",
      ".native-edit-context",
      ".monaco-editor",
      ".xterm-helper-textarea",
    ]);
  });
});

describe("isEditableTarget", () => {
  it("is false for a target that cannot answer closest — the PiP window itself", () => {
    expect(isEditableTarget({} as EventTarget)).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });

  it("is false for a plain element, so the shortcut is forwarded", () => {
    expect(isEditableTarget(fakeTarget([]))).toBe(false);
  });

  it("queries with the whole skip list at once", () => {
    const queries: string[] = [];
    isEditableTarget(fakeTarget([], queries));
    expect(queries).toEqual([SKIP_SELECTOR]);
  });

  for (const selector of [
    "input",
    "textarea",
    "select",
    "[contenteditable]",
    ".native-edit-context",
    ".monaco-editor",
    ".xterm-helper-textarea",
  ]) {
    it(`is true inside ${selector}`, () => {
      expect(isEditableTarget(fakeTarget([selector]))).toBe(true);
    });
  }
});
