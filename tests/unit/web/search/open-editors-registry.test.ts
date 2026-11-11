/**
 * What the search panel asks of the open editors: which files have unsaved changes (Replace
 * skips them, 5.8) and what the focused editor has selected (the search shortcut seeds the
 * query with it, 6.4).
 */
import { describe, it, expect, afterEach } from "bun:test";
import {
  editorFileKey,
  setEditorUnsaved,
  unsavedFileKeys,
  isFileUnsaved,
  setFocusedEditor,
  clearEditor,
  getFocusedSelection,
  type SelectionSourceEditor,
} from "../../../../src/web/lib/open-editors-registry.ts";

const used = new Set<string>();
afterEach(() => {
  for (const id of used) clearEditor(id);
  used.clear();
});
const id = (name: string) => { used.add(name); return name; };

/** A Monaco-shaped editor holding `lines`, with one selection (1-based, end exclusive). */
function fakeEditor(
  lines: string[],
  sel: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number } | null,
): SelectionSourceEditor {
  return {
    getSelection: () => sel,
    getModel: () => ({
      getValueInRange(r) {
        const out: string[] = [];
        for (let l = r.startLineNumber; l <= r.endLineNumber; l++) {
          const text = lines[l - 1] ?? "";
          const from = l === r.startLineNumber ? r.startColumn - 1 : 0;
          const to = l === r.endLineNumber ? r.endColumn - 1 : text.length;
          out.push(text.slice(from, to));
        }
        return out.join("\n");
      },
    }),
  };
}

describe("unsaved files", () => {
  it("keys a file by project and path", () => {
    expect(editorFileKey("ppm", "src/a.ts")).toBe("ppm:src/a.ts");
  });

  it("lists a file while an editor holds unsaved changes, and drops it once saved", () => {
    const a = id("ed-a");
    setEditorUnsaved(a, "ppm", "src/a.ts", true);
    expect(isFileUnsaved("ppm", "src/a.ts")).toBe(true);
    expect([...unsavedFileKeys()]).toContain("ppm:src/a.ts");
    expect(isFileUnsaved("other", "src/a.ts")).toBe(false);

    setEditorUnsaved(a, "ppm", "src/a.ts", false);
    expect(isFileUnsaved("ppm", "src/a.ts")).toBe(false);
    expect([...unsavedFileKeys()]).not.toContain("ppm:src/a.ts");
  });

  it("keeps a file unsaved while any of two editors on it is unsaved", () => {
    const a = id("ed-a");
    const b = id("ed-b");
    setEditorUnsaved(a, "ppm", "src/x.ts", true);
    setEditorUnsaved(b, "ppm", "src/x.ts", true);
    setEditorUnsaved(a, "ppm", "src/x.ts", false);
    expect(isFileUnsaved("ppm", "src/x.ts")).toBe(true);
    clearEditor(b);
    expect(isFileUnsaved("ppm", "src/x.ts")).toBe(false);
  });

  it("forgets an editor's file when it closes or moves to another file", () => {
    const a = id("ed-a");
    setEditorUnsaved(a, "ppm", "src/old.ts", true);
    setEditorUnsaved(a, "ppm", "src/new.ts", true);
    expect(isFileUnsaved("ppm", "src/old.ts")).toBe(false);
    expect(isFileUnsaved("ppm", "src/new.ts")).toBe(true);
    clearEditor(a);
    expect(unsavedFileKeys().size).toBe(0);
  });
});

describe("the focused editor's selection", () => {
  it("is null when no editor has been focused", () => {
    expect(getFocusedSelection()).toBeNull();
  });

  it("reads the selected text of the focused editor at the moment it is asked", () => {
    let sel = { startLineNumber: 2, startColumn: 7, endLineNumber: 2, endColumn: 12 };
    const editor = fakeEditor(["import x", "const value = 1;"], null);
    editor.getSelection = () => sel;
    setFocusedEditor(id("ed-a"), { tabId: "tab-1", projectName: "ppm", filePath: "src/a.ts", editor });

    expect(getFocusedSelection()).toEqual({
      tabId: "tab-1", projectName: "ppm", filePath: "src/a.ts", text: "value", singleLine: true,
    });

    sel = { startLineNumber: 1, startColumn: 1, endLineNumber: 2, endColumn: 6 };
    const multi = getFocusedSelection();
    expect(multi?.text).toBe("import x\nconst");
    expect(multi?.singleLine).toBe(false);
  });

  it("is null for an empty selection (a bare cursor)", () => {
    setFocusedEditor(id("ed-a"), {
      tabId: "tab-1", projectName: "ppm", filePath: "src/a.ts",
      editor: fakeEditor(["abc"], { startLineNumber: 1, startColumn: 2, endLineNumber: 1, endColumn: 2 }),
    });
    expect(getFocusedSelection()).toBeNull();
  });

  it("follows the editor focused last, and forgets one that closes", () => {
    setFocusedEditor(id("ed-a"), {
      tabId: "tab-a", projectName: "ppm", filePath: "a.ts",
      editor: fakeEditor(["alpha"], { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 6 }),
    });
    setFocusedEditor(id("ed-b"), {
      tabId: "tab-b", projectName: "ppm", filePath: "b.ts",
      editor: fakeEditor(["beta"], { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 5 }),
    });
    expect(getFocusedSelection()?.text).toBe("beta");

    // Closing an editor that is not the focused one changes nothing.
    clearEditor("ed-a");
    expect(getFocusedSelection()?.text).toBe("beta");

    clearEditor("ed-b");
    expect(getFocusedSelection()).toBeNull();
  });
});
