/**
 * DBGate's ⋯ in the editor of a foreign key cell: the cell's own editor, with a button beside it
 * that picks the value from the table the key refers to instead — phase 04a's Lookup, one row.
 * Choosing it closes the editor without what was typed in it; the row picked is the value.
 */
import { isObjectEditorCallbackResult, type GridCell, type ProvideEditorCallbackResult } from "@glideapps/glide-data-grid";
import { MoreHorizontal } from "@/lib/icons";
import { cellEditor } from "./cell-editor";

export function fkCellEditor(cell: GridCell, table: string, onLookup: () => void): ProvideEditorCallbackResult<GridCell> | undefined {
  const own = cellEditor(cell);
  if (!own) return undefined;
  // Its padding and styling stay the renderer's: only the editor is wrapped.
  const options = isObjectEditorCallbackResult(own) ? own : undefined;
  const Own = (options ? options.editor : own) as never as (p: object) => React.ReactNode;
  return {
    ...options,
    editor: (p) => (
      <div className="flex items-start gap-1">
        <div className="min-w-0 flex-1"><Own {...p} /></div>
        <button
          type="button" aria-label={`Look the value up in ${table}`} title={`Lookup from ${table}`}
          // Not a click away from the editor: Glide would take that as the end of the edit.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            p.onFinishedEditing(undefined, [0, 0]);
            onLookup();
          }}
          className="grid size-5 shrink-0 place-items-center rounded text-text-3 can-hover:hover:bg-surface-hover can-hover:hover:text-text"
        >
          <MoreHorizontal className="size-3.5" />
        </button>
      </div>
    ),
  };
}
