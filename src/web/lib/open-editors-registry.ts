/**
 * What the open editors tell the rest of the app, without it reaching into their components.
 *
 * - Which files have unsaved changes, keyed `project:path`. Replace skips those (5.8): writing a
 *   file under an editor holding edits would either be overwritten by its next autosave or
 *   overwrite them.
 * - The selection of the editor focused last, read when asked. The search shortcut seeds its
 *   query with a one-line selection (6.4).
 * - `applyEditorSelection`, which selects a search match in an editor (4.2).
 *
 * Kept free of Monaco and React imports: the editor types below are the few methods used.
 */

type Range = { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number };

/** A match to select: 1-based line, 1-based UTF-16 columns, end exclusive (as Monaco counts). */
export interface EditorSelectionTarget { line: number; column: number; endColumn: number }

export interface SelectionSourceEditor {
  getSelection(): Range | null;
  getModel(): { getValueInRange(range: Range): string } | null;
}

export interface SelectionTargetEditor {
  getModel(): { getLineCount(): number; getLineMaxColumn(line: number): number } | null;
  setSelection(range: Range): void;
  revealRangeInCenterIfOutsideViewport(range: Range): void;
  focus(): void;
}

export interface FocusedEditorEntry {
  tabId?: string;
  projectName?: string;
  filePath?: string;
  editor: SelectionSourceEditor;
}

export interface FocusedSelection {
  tabId?: string;
  projectName?: string;
  filePath?: string;
  text: string;
  singleLine: boolean;
}

/** Editor id → the `project:path` it holds unsaved. Per editor, since one file can be open twice. */
const unsavedByEditor = new Map<string, string>();
let focused: { editorId: string; entry: FocusedEditorEntry } | null = null;

export function editorFileKey(projectName: string, filePath: string): string {
  return `${projectName}:${filePath}`;
}

export function setEditorUnsaved(editorId: string, projectName: string, filePath: string, unsaved: boolean): void {
  if (unsaved) unsavedByEditor.set(editorId, editorFileKey(projectName, filePath));
  else unsavedByEditor.delete(editorId);
}

export function unsavedFileKeys(): Set<string> {
  return new Set(unsavedByEditor.values());
}

export function isFileUnsaved(projectName: string, filePath: string): boolean {
  const key = editorFileKey(projectName, filePath);
  for (const value of unsavedByEditor.values()) if (value === key) return true;
  return false;
}

export function setFocusedEditor(editorId: string, entry: FocusedEditorEntry): void {
  focused = { editorId, entry };
}

/** An editor unmounting: it holds nothing unsaved any more, and stops being the focused one. */
export function clearEditor(editorId: string): void {
  unsavedByEditor.delete(editorId);
  if (focused?.editorId === editorId) focused = null;
}

/** The focused editor's primary selection, or null when there is none or it is empty. */
export function getFocusedSelection(): FocusedSelection | null {
  if (!focused) return null;
  const { editor, tabId, projectName, filePath } = focused.entry;
  const sel = editor.getSelection();
  const model = editor.getModel();
  if (!sel || !model) return null;
  const text = model.getValueInRange(sel);
  if (!text) return null;
  return { tabId, projectName, filePath, text, singleLine: sel.startLineNumber === sel.endLineNumber };
}

const isPositiveInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;

/** `metadata.selection` from a tab, checked: anything malformed is ignored rather than selected. */
export function parseSelectionTarget(value: unknown): EditorSelectionTarget | null {
  if (!value || typeof value !== "object") return null;
  const { line, column, endColumn } = value as Record<string, unknown>;
  if (!isPositiveInt(line) || !isPositiveInt(column) || !isPositiveInt(endColumn)) return null;
  if (endColumn < column) return null;
  return { line, column, endColumn };
}

/**
 * Select a match and scroll it into view. Clamped to the model, because the file may have
 * changed since the search listed it; false when the editor has no model yet.
 */
export function applyEditorSelection(editor: SelectionTargetEditor, target: EditorSelectionTarget): boolean {
  const model = editor.getModel();
  if (!model) return false;
  const line = Math.min(target.line, Math.max(1, model.getLineCount()));
  const maxColumn = model.getLineMaxColumn(line);
  const startColumn = Math.min(target.column, maxColumn);
  const endColumn = Math.min(Math.max(target.endColumn, startColumn), maxColumn);
  const range = { startLineNumber: line, startColumn, endLineNumber: line, endColumn };
  editor.setSelection(range);
  editor.revealRangeInCenterIfOutsideViewport(range);
  editor.focus();
  return true;
}
