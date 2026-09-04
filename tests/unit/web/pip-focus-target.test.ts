import { describe, it, expect } from "bun:test";
import {
  PIP_FOCUS_SELECTORS,
  pipFocusTarget,
  type FocusCandidate,
} from "../../../src/web/components/floating-window/pip/pip-focus-target.ts";

interface Fake extends FocusCandidate {
  name: string;
  focused: boolean;
}

function candidate(name: string, visible = true): Fake {
  return {
    name,
    focused: false,
    checkVisibility: () => visible,
    focus() {
      this.focused = true;
    },
  };
}

/** Answers each selector from a fixed map; anything unlisted matches nothing. */
function query(matches: Record<string, Fake[]>) {
  return (selector: string): Iterable<Fake> => matches[selector] ?? [];
}

const XTERM = PIP_FOCUS_SELECTORS[0]!;
const EDIT_CONTEXT = PIP_FOCUS_SELECTORS[1]!;
const TEXTAREA = PIP_FOCUS_SELECTORS[2]!;
const CONTENTEDITABLE = PIP_FOCUS_SELECTORS[3]!;
const FOCUSABLE = PIP_FOCUS_SELECTORS[4]!;

describe("pipFocusTarget", () => {
  it("prefers the terminal's helper textarea over any other text surface", () => {
    const xterm = candidate("xterm");
    const result = pipFocusTarget(
      query({ [XTERM]: [xterm], [TEXTAREA]: [candidate("other")], [FOCUSABLE]: [candidate("button")] }),
    );
    expect(result).toBe(xterm);
  });

  it("follows the selector order when the earlier surfaces are absent", () => {
    const editContext = candidate("edit-context");
    expect(pipFocusTarget(query({ [EDIT_CONTEXT]: [editContext], [TEXTAREA]: [candidate("t")] })))
      .toBe(editContext);

    const editable = candidate("editable");
    expect(pipFocusTarget(query({ [CONTENTEDITABLE]: [editable], [FOCUSABLE]: [candidate("b")] })))
      .toBe(editable);
  });

  it("falls back to the first focusable control when no text surface exists", () => {
    const button = candidate("button");
    expect(pipFocusTarget(query({ [FOCUSABLE]: [button] }))).toBe(button);
  });

  it("skips hidden candidates — an inactive tab in the same slot must not steal input", () => {
    const hidden = candidate("hidden-tab", false);
    const visible = candidate("visible-tab");
    expect(pipFocusTarget(query({ [TEXTAREA]: [hidden, visible] }))).toBe(visible);
  });

  it("skips a whole selector whose every match is hidden", () => {
    const button = candidate("button");
    expect(pipFocusTarget(query({ [TEXTAREA]: [candidate("hidden", false)], [FOCUSABLE]: [button] })))
      .toBe(button);
  });

  it("returns null when nothing is focusable", () => {
    expect(pipFocusTarget(query({}))).toBeNull();
  });

  it("treats a missing checkVisibility() as visible when the element is laid out", () => {
    const laidOut = { focus() {}, offsetParent: {} } as FocusCandidate;
    const detached = { focus() {}, offsetParent: null } as FocusCandidate;
    expect(pipFocusTarget((s) => (s === TEXTAREA ? [detached, laidOut] : []))).toBe(laidOut);
  });
});
