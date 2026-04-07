import { useState, useCallback, useMemo } from "react";
import { useReactTable, getCoreRowModel, flexRender, type ColumnDef } from "@tanstack/react-table";
import { ChevronLeft, ChevronRight, Loader2, Trash2 } from "lucide-react";
import type { ColumnInfo } from "./use-sqlite";

interface Props {
  tableData: { columns: string[]; rows: Record<string, unknown>[]; total: number; page: number; limit: number } | null;
  schema: ColumnInfo[];
  loading: boolean;
  page: number;
  onPageChange: (page: number) => void;
  onCellUpdate: (rowid: number, column: string, value: unknown) => void;
  onRowDelete?: (rowid: number) => void;
}

export function SqliteDataGrid({ tableData, schema, loading, page, onPageChange, onCellUpdate, onRowDelete }: Props) {
  if (!tableData) {
    return (
      <div className="flex items-center justify-center h-full text-xs text-muted-foreground">
        {loading ? <Loader2 className="size-4 animate-spin" /> : "Select a table"}
      </div>
    );
  }

  const totalPages = Math.ceil(tableData.total / tableData.limit) || 1;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex-1 overflow-auto">
        <DataTable
          columns={tableData.columns}
          rows={tableData.rows}
          schema={schema}
          onCellUpdate={onCellUpdate}
          onRowDelete={onRowDelete}
        />
      </div>
      {/* Pagination */}
      <div className="flex items-center justify-between px-3 py-1.5 border-t border-border bg-background shrink-0 text-xs text-muted-foreground">
        <span>{tableData.total.toLocaleString()} rows</span>
        <div className="flex items-center gap-2">
          <button type="button" disabled={page <= 1} onClick={() => onPageChange(page - 1)}
            className="p-0.5 rounded hover:bg-muted disabled:opacity-30">
            <ChevronLeft className="size-3.5" />
          </button>
          <span>{page} / {totalPages}</span>
          <button type="button" disabled={page >= totalPages} onClick={() => onPageChange(page + 1)}
            className="p-0.5 rounded hover:bg-muted disabled:opacity-30">
            <ChevronRight className="size-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}

/** Inner table component with TanStack */
function DataTable({ columns, rows, schema, onCellUpdate, onRowDelete }: {
  columns: string[];
  rows: Record<string, unknown>[];
  schema: ColumnInfo[];
  onCellUpdate: (rowid: number, column: string, value: unknown) => void;
  onRowDelete?: (rowid: number) => void;
}) {
  const [editingCell, setEditingCell] = useState<{ rowIdx: number; col: string } | null>(null);
  const [editValue, setEditValue] = useState("");
  const [confirmDeleteIdx, setConfirmDeleteIdx] = useState<number | null>(null);

  const pkColumns = useMemo(() => new Set(schema.filter((c) => c.pk).map((c) => c.name)), [schema]);

  const startEdit = useCallback((rowIdx: number, col: string, currentValue: unknown) => {
    if (col === "rowid") return; // Don't edit rowid
    setEditingCell({ rowIdx, col });
    setEditValue(currentValue == null ? "" : String(currentValue));
  }, []);

  const commitEdit = useCallback(() => {
    if (!editingCell) return;
    const row = rows[editingCell.rowIdx];
    if (!row) return;
    const rowid = row.rowid as number;
    const oldVal = row[editingCell.col];
    if (String(oldVal ?? "") !== editValue) {
      onCellUpdate(rowid, editingCell.col, editValue === "" ? null : editValue);
    }
    setEditingCell(null);
  }, [editingCell, editValue, rows, onCellUpdate]);

  const cancelEdit = useCallback(() => setEditingCell(null), []);

  const handleDelete = useCallback((rowIdx: number) => {
    const row = rows[rowIdx];
    if (!row || !onRowDelete) return;
    onRowDelete(row.rowid as number);
    setConfirmDeleteIdx(null);
  }, [rows, onRowDelete]);

  const columnDefs = useMemo<ColumnDef<Record<string, unknown>>[]>(() => {
    const dataCols: ColumnDef<Record<string, unknown>>[] = columns.map((col) => ({
      id: col,
      accessorFn: (row) => row[col],
      header: () => (
        <span className={`${pkColumns.has(col) ? "font-bold" : ""} ${col === "rowid" ? "text-muted-foreground/50" : ""}`}>
          {col}
        </span>
      ),
      cell: ({ row, getValue }) => {
        const rowIdx = row.index;
        const isEditing = editingCell?.rowIdx === rowIdx && editingCell?.col === col;
        const val = getValue();

        if (isEditing) {
          return (
            <input
              autoFocus
              className="w-full bg-transparent border border-primary/50 rounded px-1 py-0 text-xs outline-none"
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onBlur={commitEdit}
              onKeyDown={(e) => { if (e.key === "Enter") commitEdit(); if (e.key === "Escape") cancelEdit(); }}
            />
          );
        }

        return (
          <span
            className={`cursor-pointer truncate block ${val == null ? "text-muted-foreground/40 italic" : ""} ${col === "rowid" ? "text-muted-foreground/50" : ""}`}
            onDoubleClick={() => startEdit(rowIdx, col, val)}
            title={val == null ? "NULL" : String(val)}
          >
            {val == null ? "NULL" : String(val)}
          </span>
        );
      },
    }));

    if (onRowDelete) {
      dataCols.push({
        id: "_actions",
        header: () => null,
        cell: ({ row }) => {
          const rowIdx = row.index;
          const isConfirming = confirmDeleteIdx === rowIdx;
          if (isConfirming) {
            return (
              <span className="flex items-center gap-1 whitespace-nowrap">
                <button type="button" onClick={() => handleDelete(rowIdx)}
                  className="text-destructive text-[10px] font-medium hover:underline">
                  Confirm
                </button>
                <button type="button" onClick={() => setConfirmDeleteIdx(null)}
                  className="text-muted-foreground text-[10px] hover:underline">
                  Cancel
                </button>
              </span>
            );
          }
          return (
            <button type="button" onClick={() => setConfirmDeleteIdx(rowIdx)}
              className="p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-destructive/10 hover:text-destructive transition-opacity"
              title="Delete row">
              <Trash2 className="size-3" />
            </button>
          );
        },
        size: 60,
      });
    }

    return dataCols;
  },
  [columns, pkColumns, editingCell, editValue, commitEdit, cancelEdit, startEdit, onRowDelete, confirmDeleteIdx, handleDelete]); // eslint-disable-line react-hooks/exhaustive-deps

  const table = useReactTable({
    data: rows,
    columns: columnDefs,
    getCoreRowModel: getCoreRowModel(),
  });

  return (
    <table className="w-full text-xs border-collapse">
      <thead className="sticky top-0 z-10 bg-muted">
        {table.getHeaderGroups().map((hg) => (
          <tr key={hg.id}>
            {hg.headers.map((h) => (
              <th key={h.id} className="px-2 py-1.5 text-left font-medium text-muted-foreground border-b border-border whitespace-nowrap">
                {flexRender(h.column.columnDef.header, h.getContext())}
              </th>
            ))}
          </tr>
        ))}
      </thead>
      <tbody>
        {table.getRowModel().rows.map((row) => (
          <tr key={row.id} className="group hover:bg-muted/30 border-b border-border/50">
            {row.getVisibleCells().map((cell) => (
              <td key={cell.id} className="px-2 py-1 max-w-[300px]">
                {flexRender(cell.column.columnDef.cell, cell.getContext())}
              </td>
            ))}
          </tr>
        ))}
        {rows.length === 0 && (
          <tr>
            <td colSpan={columns.length} className="px-2 py-8 text-center text-muted-foreground">
              No data
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}
