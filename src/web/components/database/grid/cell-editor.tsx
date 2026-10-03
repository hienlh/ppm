/**
 * Glide's own text and number editors, with Enter and Tab putting in what was typed there and then.
 *
 * Glide 6.0.3 ends an edit from a timer, one per key pressed in the editor, and each timer reads the
 * move the latest Enter or Tab asked for while saving only when its own key was that one. The last
 * letter's timer, still waiting when Enter arrives — Enter within a millisecond or two of it, or a
 * frame the page spent busy — closes the editor with nothing saved and moves on, and what was typed
 * is gone without a word. Ending the edit on the key itself leaves every timer finding it ended.
 */
import {
  GridCellKind, isObjectEditorCallbackResult, numberCellRenderer, textCellRenderer,
  type GridCell, type NumberCell, type ProvideEditorCallbackResult, type ProvideEditorComponent, type TextCell,
} from "@glideapps/glide-data-grid";
import { useRef } from "react";

type Movement = readonly [-1 | 0 | 1, -1 | 0 | 1];
type EditorProps = Parameters<ProvideEditorComponent<GridCell>>[0];

/** Where Enter and Tab move the cursor once the value is in, as Glide's editor moves it; null for any other key. */
export function finishingMove(e: { key: string; shiftKey: boolean; nativeEvent: { isComposing: boolean } }): Movement | null {
  // Enter confirms what an input method is composing: the edit goes on.
  if (e.nativeEvent.isComposing) return null;
  if (e.key === "Tab") return [e.shiftKey ? -1 : 1, 0];
  // Shift+Enter is a new line in the text.
  if (e.key === "Enter" && !e.shiftKey) return [0, 1];
  return null;
}

/** The editor of a text or number cell; none for a cell either serves, which keeps Glide's own. */
export function cellEditor(cell: GridCell): ProvideEditorCallbackResult<GridCell> | undefined {
  // Each renderer's editor is typed for its own kind; this only hands the props on.
  const own = (cell.kind === GridCellKind.Text
    ? textCellRenderer.provideEditor?.(cell as TextCell)
    : cell.kind === GridCellKind.Number ? numberCellRenderer.provideEditor?.(cell as NumberCell) : undefined) as ProvideEditorCallbackResult<GridCell> | undefined;
  if (!own) return undefined;
  // Its padding and styling stay the renderer's: only the editor is wrapped.
  const options = isObjectEditorCallbackResult(own) ? own : undefined;
  const Own = (options ? options.editor : own) as ProvideEditorComponent<GridCell>;
  function Editor(p: EditorProps) {
    // What Glide would save: the value last typed, or — opened by typing — the key that opened it.
    const typed = useRef<GridCell | undefined>(p.forceEditMode ? p.value : undefined);
    return (
      <div
        className="contents"
        onKeyDown={(e) => {
          const move = finishingMove(e);
          if (move) p.onFinishedEditing(typed.current, move);
        }}
      >
        <Own {...p} onChange={(value) => { typed.current = value; p.onChange(value); }} />
      </div>
    );
  }
  return { ...options, editor: Editor };
}
