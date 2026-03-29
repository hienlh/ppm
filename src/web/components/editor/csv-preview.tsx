import { useState, useMemo, useRef, useCallback, useEffect } from "react";
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  flexRender,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { parseCsv, serializeCsv } from "@/lib/csv-parser";
import { ArrowUp, ArrowDown } from "lucide-react";

interface CsvPreviewProps {
  content: string;
  onContentChange: (csv: string) => void;
}

export function CsvPreview({ content, onContentChange }: CsvPreviewProps) {
  const parsed = useMemo(() => parseCsv(content), [content]);
  const [rows, setRows] = useState<string[][]>(() => parsed.rows);
  const [sorting, setSorting] = useState<SortingState>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const internalEditRef = useRef(false);

  // Sync when content changes externally (e.g. file reload) — skip if we triggered it
  useEffect(() => {
    if (internalEditRef.current) {
      internalEditRef.current = false;
      return;
    }
    setRows(parsed.rows);
  }, [parsed.rows]);

  const headers = parsed.headers;

  const updateCell = useCallback(
    (rowIndex: number, colIndex: number, value: string) => {
      setRows((prev) => {
        const next = prev.map((r, i) => (i === rowIndex ? [...r] : r));
        next[rowIndex]![colIndex] = value;
        internalEditRef.current = true;
        onContentChange(serializeCsv(headers, next));
        return next;
      });
    },
    [headers, onContentChange],
  );

  const columns = useMemo<ColumnDef<string[], string>[]>(
    () =>
      headers.map((h, i) => ({
        id: `col-${i}`,
        header: h || `Column ${i + 1}`,
        accessorFn: (row: string[]) => row[i] ?? "",
        cell: ({ row, getValue }) => (
          <CsvCell
            value={getValue()}
            onSave={(v) => updateCell(row.index, i, v)}
          />
        ),
        size: 150,
        minSize: 80,
      })),
    [headers, updateCell],
  );

  const table = useReactTable({
    data: rows,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    enableColumnResizing: true,
    columnResizeMode: "onChange",
  });

  const { rows: tableRows } = table.getRowModel();

  const virtualizer = useVirtualizer({
    count: tableRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 32,
    overscan: 20,
  });

  if (headers.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        Empty CSV file
      </div>
    );
  }

  return (
    <div ref={scrollRef} className="flex-1 overflow-auto">
      <table className="w-full text-xs font-mono border-collapse">
        <thead className="sticky top-0 bg-background z-10 border-b border-border block">
          {table.getHeaderGroups().map((hg) => (
            <tr key={hg.id} className="flex w-full">
              {hg.headers.map((header) => (
                <th
                  key={header.id}
                  className="relative text-left px-2 py-1.5 font-medium text-muted-foreground select-none cursor-pointer hover:bg-muted/50 border-r border-border last:border-r-0"
                  style={{ width: header.getSize(), minWidth: header.getSize() }}
                  onClick={header.column.getToggleSortingHandler()}
                >
                  <div className="flex items-center gap-1">
                    <span className="truncate">
                      {flexRender(header.column.columnDef.header, header.getContext())}
                    </span>
                    {header.column.getIsSorted() === "asc" && <ArrowUp className="size-3 shrink-0" />}
                    {header.column.getIsSorted() === "desc" && <ArrowDown className="size-3 shrink-0" />}
                  </div>
                  {/* Resize handle */}
                  <div
                    onMouseDown={header.getResizeHandler()}
                    onTouchStart={header.getResizeHandler()}
                    onClick={(e) => e.stopPropagation()}
                    className="absolute right-0 top-0 h-full w-1 cursor-col-resize hover:bg-primary/50 active:bg-primary"
                  />
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody style={{ height: virtualizer.getTotalSize(), position: "relative", display: "block" }}>
          {virtualizer.getVirtualItems().map((vRow) => {
            const row = tableRows[vRow.index]!;
            return (
              <tr
                key={row.id}
                data-index={vRow.index}
                ref={(node) => virtualizer.measureElement(node)}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${vRow.start}px)`,
                  display: "flex",
                }}
              >
                {row.getVisibleCells().map((cell) => (
                  <td
                    key={cell.id}
                    className="px-2 py-1 border-b border-border/50 border-r border-r-border/30 last:border-r-0 truncate"
                    style={{ width: cell.column.getSize(), minWidth: cell.column.getSize() }}
                  >
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function CsvCell({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  if (!editing) {
    return (
      <span
        className="block truncate cursor-text"
        onClick={() => {
          setDraft(value);
          setEditing(true);
        }}
      >
        {value || "\u00A0"}
      </span>
    );
  }

  return (
    <input
      ref={inputRef}
      className="w-full bg-transparent outline-none border-b border-primary text-xs font-mono"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        setEditing(false);
        if (draft !== value) onSave(draft);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          setEditing(false);
          if (draft !== value) onSave(draft);
        } else if (e.key === "Escape") {
          setEditing(false);
          setDraft(value);
        }
      }}
    />
  );
}
