/**
 * Opening a search result selects the matched text and scrolls it into view (4.2), instead of
 * jumping to the start of its line.
 *
 * The tab carries `metadata.selection = { line, column, endColumn }` (1-based UTF-16, end
 * exclusive, as Monaco counts). `applyEditorSelection` turns it into a Monaco selection;
 * the editor component itself is too heavy to mount here, so its wiring is read from source.
 */
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  applyEditorSelection,
  parseSelectionTarget,
  type SelectionTargetEditor,
} from "../../../../src/web/lib/open-editors-registry.ts";

type Range = { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number };

function fakeEditor(lines: string[]) {
  const calls: { selection?: Range; revealed?: Range; focused: boolean } = { focused: false };
  const editor: SelectionTargetEditor = {
    getModel: () => ({
      getLineCount: () => lines.length,
      getLineMaxColumn: (line: number) => (lines[line - 1] ?? "").length + 1,
    }),
    setSelection: (r: Range) => { calls.selection = r; },
    revealRangeInCenterIfOutsideViewport: (r: Range) => { calls.revealed = r; },
    focus: () => { calls.focused = true; },
  };
  return { editor, calls };
}

describe("parseSelectionTarget", () => {
  it("accepts a one-line range", () => {
    expect(parseSelectionTarget({ line: 3, column: 5, endColumn: 9 })).toEqual({ line: 3, column: 5, endColumn: 9 });
  });

  it("rejects anything that is not a positive, ordered range", () => {
    expect(parseSelectionTarget(undefined)).toBeNull();
    expect(parseSelectionTarget({ line: 0, column: 1, endColumn: 2 })).toBeNull();
    expect(parseSelectionTarget({ line: 1, column: 0, endColumn: 2 })).toBeNull();
    expect(parseSelectionTarget({ line: 1, column: 4, endColumn: 2 })).toBeNull();
    expect(parseSelectionTarget({ line: "1", column: 1, endColumn: 2 })).toBeNull();
    expect(parseSelectionTarget({ line: 1.5, column: 1, endColumn: 2 })).toBeNull();
  });
});

describe("applyEditorSelection", () => {
  it("selects exactly the match, reveals it and focuses the editor", () => {
    const { editor, calls } = fakeEditor(["", "const needle = 1;"]);
    expect(applyEditorSelection(editor, { line: 2, column: 7, endColumn: 13 })).toBe(true);

    const range = { startLineNumber: 2, startColumn: 7, endLineNumber: 2, endColumn: 13 };
    expect(calls.selection).toEqual(range);
    expect(calls.revealed).toEqual(range);
    expect(calls.focused).toBe(true);
  });

  it("clamps to the line when the file got shorter since the search", () => {
    const { editor, calls } = fakeEditor(["short"]);
    expect(applyEditorSelection(editor, { line: 1, column: 4, endColumn: 40 })).toBe(true);
    expect(calls.selection).toEqual({ startLineNumber: 1, startColumn: 4, endLineNumber: 1, endColumn: 6 });
  });

  it("clamps to the last line when the file lost lines", () => {
    const { editor, calls } = fakeEditor(["one", "two"]);
    applyEditorSelection(editor, { line: 9, column: 2, endColumn: 3 });
    expect(calls.selection).toEqual({ startLineNumber: 2, startColumn: 2, endLineNumber: 2, endColumn: 3 });
  });

  it("does nothing before the editor has a model", () => {
    const { editor, calls } = fakeEditor([]);
    editor.getModel = () => null;
    expect(applyEditorSelection(editor, { line: 1, column: 1, endColumn: 2 })).toBe(false);
    expect(calls.selection).toBeUndefined();
  });
});

describe("the editor component", () => {
  const src = readFileSync(resolve(import.meta.dir, "../../../../src/web/components/editor/code-editor.tsx"), "utf8");

  it("selects metadata.selection when it reveals a target", () => {
    expect(src).toContain("parseSelectionTarget(metadata?.selection)");
    expect(src).toMatch(/applyEditorSelection\(editor, /);
  });

  it("reports its unsaved state and its focus to the registry, and leaves it on unmount", () => {
    expect(src).toMatch(/setEditorUnsaved\(/);
    expect(src).toMatch(/setFocusedEditor\(/);
    expect(src).toMatch(/onDidFocusEditorText\(/);
    expect(src).toMatch(/clearEditor\(/);
  });
});
