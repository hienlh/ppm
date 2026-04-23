import { useState, useRef } from "react";
import { Search, X, Trash2, Plus, Columns } from "lucide-react";
import { ExportButton } from "./export-button";
import { GlideColumnSearch } from "./glide-column-search";

interface ToolbarProps {
  hasSelection: boolean;
  selectedCount: number;
  onBulkDelete?: () => void;
  onInsertRow?: () => void;
  columns: string[];
  selectedRows: Record<string, unknown>[];
  connectionName?: string;
  searchTerm: string;
  onSearchChange: (term: string) => void;
  onColumnJump?: (colName: string) => void;
  /** Controlled column search open state (from parent "/" shortcut) */
  colSearchOpen?: boolean;
  onColSearchChange?: (open: boolean) => void;
}

/**
 * Toolbar above the Glide Data Grid — bulk actions, search, column jump, insert, export.
 */
export function GlideGridToolbar({
  hasSelection, selectedCount, onBulkDelete, onInsertRow,
  columns, selectedRows, connectionName,
  searchTerm, onSearchChange, onColumnJump,
  colSearchOpen: externalOpen, onColSearchChange,
}: ToolbarProps) {
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const [internalOpen, setInternalOpen] = useState(false);
  const colSearchOpen = externalOpen ?? internalOpen;
  const setColSearchOpen = onColSearchChange ?? setInternalOpen;
  const colSearchBtnRef = useRef<HTMLButtonElement>(null);

  const colSearchPos = colSearchBtnRef.current
    ? (() => { const r = colSearchBtnRef.current!.getBoundingClientRect(); return { x: r.left, y: r.bottom + 4 }; })()
    : { x: 0, y: 0 };

  return (
    <div className="flex items-center gap-2 px-2 py-1 border-b border-border bg-background shrink-0">
      {/* Selection info + bulk actions */}
      {hasSelection && (
        <div className="flex items-center gap-1.5 text-xs">
          <span className="text-muted-foreground">{selectedCount} selected</span>
          {onBulkDelete && (
            confirmBulkDelete ? (
              <span className="flex items-center gap-1">
                <button type="button" onClick={() => { onBulkDelete(); setConfirmBulkDelete(false); }}
                  className="text-destructive text-[10px] font-medium hover:underline">
                  Delete {selectedCount}?
                </button>
                <button type="button" onClick={() => setConfirmBulkDelete(false)}
                  className="text-muted-foreground text-[10px] hover:underline">Cancel</button>
              </span>
            ) : (
              <button type="button" onClick={() => setConfirmBulkDelete(true)}
                className="p-0.5 text-muted-foreground hover:text-destructive">
                <Trash2 className="size-3" />
              </button>
            )
          )}
          <ExportButton columns={columns} rows={selectedRows} filename={`${connectionName ?? "db"}-selected`} />
        </div>
      )}

      <div className="flex-1" />

      {/* Client-side search */}
      <div className="flex items-center gap-1 text-xs">
        <Search className="size-3 text-muted-foreground" />
        <input value={searchTerm} onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search page…"
          className="w-24 bg-transparent outline-none text-foreground placeholder:text-muted-foreground text-xs" />
        {searchTerm && (
          <button type="button" onClick={() => onSearchChange("")}
            className="text-muted-foreground hover:text-foreground">
            <X className="size-3" />
          </button>
        )}
      </div>

      {/* Column jump */}
      {onColumnJump && (
        <button ref={colSearchBtnRef} type="button" onClick={() => setColSearchOpen(!colSearchOpen)}
          className="p-0.5 rounded text-muted-foreground hover:text-foreground transition-colors" title="Jump to column (/)">
          <Columns className="size-3.5" />
        </button>
      )}

      {/* Insert row */}
      {onInsertRow && (
        <button type="button" onClick={onInsertRow}
          className="p-0.5 rounded text-muted-foreground hover:text-primary transition-colors" title="Insert row">
          <Plus className="size-3.5" />
        </button>
      )}

      {colSearchOpen && onColumnJump && (
        <GlideColumnSearch columns={columns} onSelect={onColumnJump} onClose={() => setColSearchOpen(false)} anchorRect={colSearchPos} />
      )}
    </div>
  );
}
